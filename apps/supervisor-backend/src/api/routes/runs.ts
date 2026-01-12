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
      // Store error state so it shows up in the UI
      runStore.set(runId, {
        run_id: runId,
        status: 'failed',
        user_goal: request.goal,
        repo_path: request.repo_path,
        project_id: request.project_id,
        error: error instanceof Error ? error.message : String(error),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        reports: [],
      } as any);
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

export { runs };
