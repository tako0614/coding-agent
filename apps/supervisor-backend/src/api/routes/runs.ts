/**
 * Run management API routes
 *
 * Uses Supervisor Agent pattern with GPT orchestrating Claude/Codex workers.
 */

import { Hono } from 'hono';
import { createRunId } from '@supervisor/protocol';
import { CreateRunRequestSchema, type RunListResponse } from '../types.js';
import { runStore } from '../run-store.js';
import { runSimplifiedSupervisor } from '../../graph/index.js';
import { agentStore } from '../../supervisor/index.js';

const runs = new Hono();

/**
 * GET /api/runs
 * List all runs
 */
runs.get('/', (c) => {
  console.log('[API] GET /api/runs called');
  const allRuns = runStore.list();
  console.log(`[API] GET /api/runs returning ${allRuns.length} runs`);
  const response: RunListResponse = {
    runs: allRuns,
    total: allRuns.length,
  };
  return c.json(response);
});

/**
 * POST /api/runs
 * Create and start a new run with Supervisor Agent
 */
runs.post('/', async (c) => {
  console.log('[API] POST /api/runs received');
  try {
    const body = await c.req.json();
    console.log('[API] Request body:', JSON.stringify(body));
    const parsed = CreateRunRequestSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({
        error: {
          message: 'Invalid request body',
          details: parsed.error.errors,
        },
      }, 400);
    }

    const request = parsed.data;
    const runId = createRunId();

    console.log(`[API] Creating run ${runId} for project: ${request.project_id ?? 'none'}`);

    // Use Supervisor Agent
    const runPromise = runSimplifiedSupervisor({
      userGoal: request.goal,
      repoPath: request.repo_path,
      runId,
      projectId: request.project_id,
    });
    runStore.setRunning(runId, runPromise, request.goal, request.project_id, request.repo_path);

    runPromise.then(finalState => {
      runStore.set(runId, finalState);
      console.log(`[API] Run ${runId} completed with status: ${finalState.status}`);
    }).catch(error => {
      console.error(`[API] Run ${runId} failed:`, error);
      // Store error state using markFailed to properly cleanup tracking
      const errorMsg = error instanceof Error ? error.message : String(error);
      runStore.markFailed(runId, errorMsg);
    });

    return c.json({
      run_id: runId,
      status: 'pending',
      project_id: request.project_id,
      message: 'Run started with Supervisor Agent',
    }, 202);
  } catch (error) {
    console.error('[API] Error creating run:', error);
    return c.json({
      error: {
        message: error instanceof Error ? error.message : 'Internal server error',
      },
    }, 500);
  }
});

/**
 * GET /api/runs/:id
 * Get a specific run
 */
runs.get('/:id', async (c) => {
  const runId = c.req.param('id');

  // Check if run is still executing
  if (runStore.isRunning(runId)) {
    return c.json({
      run_id: runId,
      status: 'running',
      message: 'Run is still executing',
    });
  }

  const state = runStore.get(runId);

  if (!state) {
    return c.json({
      error: {
        message: `Run ${runId} not found`,
      },
    }, 404);
  }

  return c.json(runStore.toResponse(state));
});

/**
 * GET /api/runs/:id/logs
 * Get logs for a run
 */
runs.get('/:id/logs', (c) => {
  const runId = c.req.param('id');
  const state = runStore.get(runId);

  if (!state) {
    return c.json({
      error: {
        message: `Run ${runId} not found`,
      },
    }, 404);
  }

  // Logs are available via SSE events, return empty for now
  return c.json({ logs: [] });
});

/**
 * GET /api/runs/:id/report
 * Get the final report for a run
 */
runs.get('/:id/report', (c) => {
  const runId = c.req.param('id');
  const state = runStore.get(runId);

  if (!state) {
    return c.json({
      error: {
        message: `Run ${runId} not found`,
      },
    }, 404);
  }

  if (!state.final_summary) {
    return c.json({
      error: {
        message: `Run ${runId} has not completed yet`,
      },
    }, 404);
  }

  return c.text(state.final_summary, 200, {
    'Content-Type': 'text/markdown',
  });
});

/**
 * DELETE /api/runs/:id
 * Delete a run
 */
runs.delete('/:id', (c) => {
  const runId = c.req.param('id');

  if (runStore.isRunning(runId)) {
    return c.json({
      error: {
        message: `Cannot delete running run ${runId}`,
      },
    }, 409);
  }

  const deleted = runStore.delete(runId);

  if (!deleted) {
    return c.json({
      error: {
        message: `Run ${runId} not found`,
      },
    }, 404);
  }

  return c.json({ message: `Run ${runId} deleted` });
});

/**
 * GET /api/runs/:id/workers
 * Get worker pool status for a run
 */
runs.get('/:id/workers', (c) => {
  const runId = c.req.param('id');

  if (runStore.has(runId)) {
    if (runStore.isRunning(runId)) {
      return c.json({
        error: {
          message: `Run ${runId} is still executing`,
        },
      }, 202);
    }

    const workerPool = runStore.getWorkerPool(runId);
    if (workerPool) {
      return c.json(workerPool);
    }
  }

  return c.json({
    error: {
      message: `Worker pool not found for run ${runId}`,
    },
  }, 404);
});

/**
 * POST /api/runs/:id/restart
 * Restart a failed or completed run
 */
runs.post('/:id/restart', async (c) => {
  const runId = c.req.param('id');
  console.log(`[API] POST /api/runs/${runId}/restart received`);

  // Check if run is currently running
  if (runStore.isRunning(runId)) {
    return c.json({
      error: {
        message: `Run ${runId} is still running, cannot restart`,
      },
    }, 409);
  }

  // Get the agent instance
  const agent = agentStore.get(runId);
  if (!agent) {
    return c.json({
      error: {
        message: `Agent instance not found for run ${runId}. Cannot restart - please create a new run.`,
      },
    }, 404);
  }

  // Check if agent can be restarted
  if (!agent.canRestart()) {
    return c.json({
      error: {
        message: `Run ${runId} cannot be restarted (current state doesn't allow restart)`,
      },
    }, 400);
  }

  // Start restart in background
  const restartPromise = agent.restart().then(finalState => {
    // Update run store with new state
    runStore.set(runId, {
      run_id: finalState.run_id,
      status: finalState.phase === 'completed' ? 'completed' : 'failed',
      user_goal: finalState.user_goal,
      repo_path: finalState.repo_path,
      created_at: finalState.created_at,
      updated_at: finalState.updated_at,
      final_summary: finalState.final_summary,
      error: finalState.error,
      reports: finalState.completed_tasks
        .filter(t => t.report)
        .map(t => t.report!),
    } as any);
    console.log(`[API] Run ${runId} restart completed with status: ${finalState.phase}`);
  }).catch(error => {
    console.error(`[API] Run ${runId} restart failed:`, error);
    const errorMsg = error instanceof Error ? error.message : String(error);
    runStore.markFailed(runId, errorMsg);
  });

  // Track as running
  runStore.setRunning(runId, restartPromise as any, agent.getState().user_goal);

  return c.json({
    run_id: runId,
    status: 'restarting',
    message: 'Run is being restarted',
  }, 202);
});

/**
 * POST /api/runs/:id/cancel
 * Cancel a running run
 */
runs.post('/:id/cancel', (c) => {
  const runId = c.req.param('id');
  console.log(`[API] POST /api/runs/${runId}/cancel received`);

  const agent = agentStore.get(runId);
  if (!agent) {
    return c.json({
      error: {
        message: `Agent instance not found for run ${runId}`,
      },
    }, 404);
  }

  agent.cancel('Cancelled by user via API');

  return c.json({
    run_id: runId,
    status: 'cancelled',
    message: 'Run has been cancelled',
  });
});

export { runs };
