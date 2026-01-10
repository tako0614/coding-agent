/**
 * Run management API routes
 *
 * All runs use parallel execution by default with dynamic worker scaling.
 */

import { Hono } from 'hono';
import { createRunId } from '@supervisor/protocol';
import { CreateRunRequestSchema, type RunListResponse } from '../types.js';
import { parallelRunStore } from '../run-store.js';
import { runParallelSupervisor } from '../../graph/parallel-graph.js';

const runs = new Hono();

/**
 * GET /api/runs
 * List all runs
 */
runs.get('/', (c) => {
  const allRuns = parallelRunStore.list();
  const response: RunListResponse = {
    runs: allRuns,
    total: allRuns.length,
  };
  return c.json(response);
});

/**
 * POST /api/runs
 * Create and start a new run with parallel execution and dynamic worker scaling
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

    // Always use parallel execution with dynamic worker scaling
    const runPromise = runParallelSupervisor(
      request.goal,
      request.repo_path,
      runId,
      request.project_id
    );
    parallelRunStore.setRunning(runId, runPromise, request.goal, request.project_id, request.repo_path);

    runPromise.then(finalState => {
      parallelRunStore.set(runId, finalState);
      console.log(`[API] Run ${runId} completed with status: ${finalState.status}`);
    }).catch(error => {
      console.error(`[API] Run ${runId} failed:`, error);
      // Store error state so it shows up in the UI
      parallelRunStore.set(runId, {
        run_id: runId,
        status: 'failed',
        user_goal: request.goal,
        repo_path: request.repo_path,
        project_id: request.project_id,
        error: error instanceof Error ? error.message : String(error),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        reports: [],
        model_policy: { auto_downgrade: true },
        security_policy: { sandbox_enforced: true },
      } as any);
    });

    return c.json({
      run_id: runId,
      status: 'pending',
      project_id: request.project_id,
      message: 'Run started with dynamic parallel execution',
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
  if (parallelRunStore.isRunning(runId)) {
    return c.json({
      run_id: runId,
      status: 'running',
      message: 'Run is still executing',
    });
  }

  const state = parallelRunStore.get(runId);

  if (!state) {
    return c.json({
      error: {
        message: `Run ${runId} not found`,
      },
    }, 404);
  }

  return c.json(parallelRunStore.toResponse(state));
});

/**
 * GET /api/runs/:id/logs
 * Get logs for a run
 */
runs.get('/:id/logs', (c) => {
  const runId = c.req.param('id');
  const state = parallelRunStore.get(runId);

  if (!state) {
    return c.json({
      error: {
        message: `Run ${runId} not found`,
      },
    }, 404);
  }

  // Extract logs from task reports
  const logs: Array<{ timestamp: string; level: string; message: string }> = [];

  // Add DAG node status logs
  if (state.dag) {
    for (const node of state.dag.nodes) {
      if (node.started_at) {
        logs.push({
          timestamp: node.started_at,
          level: 'info',
          message: `Task ${node.name} started (worker: ${node.assigned_worker_id ?? 'unknown'})`,
        });
      }
      if (node.completed_at) {
        logs.push({
          timestamp: node.completed_at,
          level: node.status === 'completed' ? 'info' : 'error',
          message: `Task ${node.name} ${node.status}${node.error ? `: ${node.error}` : ''}`,
        });
      }
    }
  }

  // Sort by timestamp
  logs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return c.json({ logs });
});

/**
 * GET /api/runs/:id/report
 * Get the final report for a run
 */
runs.get('/:id/report', (c) => {
  const runId = c.req.param('id');
  const state = parallelRunStore.get(runId);

  if (!state) {
    return c.json({
      error: {
        message: `Run ${runId} not found`,
      },
    }, 404);
  }

  if (!state.final_report) {
    return c.json({
      error: {
        message: `Run ${runId} has not completed yet`,
      },
    }, 404);
  }

  return c.text(state.final_report, 200, {
    'Content-Type': 'text/markdown',
  });
});

/**
 * DELETE /api/runs/:id
 * Delete a run
 */
runs.delete('/:id', (c) => {
  const runId = c.req.param('id');

  if (parallelRunStore.isRunning(runId)) {
    return c.json({
      error: {
        message: `Cannot delete running run ${runId}`,
      },
    }, 409);
  }

  const deleted = parallelRunStore.delete(runId);

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
 * GET /api/runs/:id/dag
 * Get DAG for a parallel run
 */
runs.get('/:id/dag', (c) => {
  const runId = c.req.param('id');

  // Check parallel runs first
  if (parallelRunStore.has(runId)) {
    if (parallelRunStore.isRunning(runId)) {
      return c.json({
        error: {
          message: `Run ${runId} is still executing, DAG not yet available`,
        },
      }, 202);
    }

    const dag = parallelRunStore.getDAG(runId);
    if (dag) {
      return c.json(dag);
    }
  }

  return c.json({
    error: {
      message: `DAG not found for run ${runId}`,
    },
  }, 404);
});

/**
 * GET /api/runs/:id/workers
 * Get worker pool status for a parallel run
 */
runs.get('/:id/workers', (c) => {
  const runId = c.req.param('id');

  // Check parallel runs first
  if (parallelRunStore.has(runId)) {
    if (parallelRunStore.isRunning(runId)) {
      return c.json({
        error: {
          message: `Run ${runId} is still executing`,
        },
      }, 202);
    }

    const workerPool = parallelRunStore.getWorkerPool(runId);
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
