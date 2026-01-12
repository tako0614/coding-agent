/**
 * Parallel Dispatch Node
 * Orchestrates parallel task execution using WorkerPool and DAGScheduler
 *
 * Worker count is dynamically determined based on DAG complexity:
 * - min(maxConcurrentTasks, 20) workers
 * - Maximum concurrent tasks is calculated from DAG dependency graph
 */

import type { DAGNode, WorkReport, DAGProgress, WorkerPoolConfig } from '@supervisor/protocol';
import type { ParallelSupervisorStateType } from '../parallel-state.js';
import { WorkerPool, createWorkerPool, DAGScheduler, createDAGScheduler } from '../../workers/index.js';
import { EventEmitter } from 'events';
import { log as eventLog } from '../../services/event-bus.js';
import { getExecutorMode } from '../../services/settings-store.js';

// Global event emitter for SSE updates
export const parallelDispatchEvents = new EventEmitter();

export interface ParallelDispatchEvent {
  type: 'task_started' | 'task_completed' | 'task_failed' | 'worker_status' | 'progress';
  run_id: string;
  timestamp: string;
  data: {
    task_id?: string;
    worker_id?: string;
    report?: WorkReport;
    error?: string;
    progress?: DAGProgress;
    duration_ms?: number;
  };
}

/**
 * Calculate optimal worker count based on DAG structure
 * No hard limits - scales based on actual task count (1-15 tasks expected)
 */
function calculateOptimalWorkerCount(dag: ParallelSupervisorStateType['dag']): Partial<WorkerPoolConfig> {
  if (!dag || dag.nodes.length === 0) {
    return { min_workers: 1, max_workers: 1 };
  }

  // Find maximum parallelism (tasks that can run concurrently)
  const nodeLevels = new Map<string, number>();
  const nodesByTaskId = new Map(dag.nodes.map(n => [n.task_id, n]));

  // Calculate level for each node (longest path from start)
  function getLevel(taskId: string, visited: Set<string> = new Set()): number {
    if (nodeLevels.has(taskId)) {
      return nodeLevels.get(taskId)!;
    }

    if (visited.has(taskId)) {
      return 0;
    }
    visited.add(taskId);

    const node = nodesByTaskId.get(taskId);
    if (!node || node.dependencies.length === 0) {
      nodeLevels.set(taskId, 0);
      return 0;
    }

    const maxDepLevel = Math.max(...node.dependencies.map(d => getLevel(d, visited)));
    const level = maxDepLevel + 1;
    nodeLevels.set(taskId, level);
    return level;
  }

  for (const node of dag.nodes) {
    getLevel(node.task_id);
  }

  // Count nodes at each level
  const levelCounts = new Map<number, number>();
  for (const [, level] of nodeLevels) {
    levelCounts.set(level, (levelCounts.get(level) ?? 0) + 1);
  }

  // Maximum concurrent tasks is the maximum nodes at any level
  const maxConcurrent = Math.max(...Array.from(levelCounts.values()), 1);

  // Scale workers to match task concurrency (no artificial limits)
  const workerCount = Math.max(1, maxConcurrent);

  console.log(`[ParallelDispatch] DAG: ${dag.nodes.length} tasks, max concurrency: ${maxConcurrent}, workers: ${workerCount}`);

  return {
    min_workers: workerCount,
    max_workers: workerCount,
  };
}

/**
 * Parallel dispatch node - executes all DAG tasks using worker pool
 */
export async function parallelDispatchNode(
  state: ParallelSupervisorStateType
): Promise<Partial<ParallelSupervisorStateType>> {
  console.log('[ParallelDispatch] Starting parallel execution...');

  if (!state.dag) {
    throw new Error('No DAG found in state');
  }

  eventLog(state.run_id, 'info', 'supervisor', `🚀 Starting parallel execution with ${state.dag.nodes.length} tasks`);

  // Create scheduler
  const scheduler = createDAGScheduler(state.dag);

  // Calculate optimal worker count based on DAG complexity
  const dynamicConfig = calculateOptimalWorkerCount(state.dag);

  // Get executor mode from settings
  const executorMode = getExecutorMode();
  eventLog(state.run_id, 'info', 'system', `Worker pool config: ${dynamicConfig.min_workers}-${dynamicConfig.max_workers} workers (mode: ${executorMode})`);

  // Create worker pool with dynamic configuration and context
  const pool = createWorkerPool(
    dynamicConfig,
    state.repo_path,
    state.run_id,
    {
      userGoal: state.user_goal,
      repoContext: state.repo_context,
      dag: state.dag,
      executorMode,
    }
  );

  // Initialize pool
  await pool.initialize();

  // Track reports
  const reports: WorkReport[] = [];

  // Set up event handlers
  setupEventHandlers(pool, scheduler, state.run_id);

  try {
    // Main execution loop
    while (!scheduler.isComplete()) {
      const readyTasks = scheduler.getReadyTasks();
      const idleCount = pool.getIdleCount();

      // Emit progress
      emitProgressEvent(state.run_id, scheduler.getProgress());

      if (readyTasks.length === 0 && !scheduler.hasRunningTasks()) {
        // No ready tasks and nothing running - we're done or stuck
        break;
      }

      // Dispatch tasks to available workers
      const dispatchPromises: Promise<void>[] = [];
      const tasksToDispatch = readyTasks.slice(0, idleCount);

      for (const task of tasksToDispatch) {
        scheduler.markRunning(task.task_id);
        emitTaskStartedEvent(state.run_id, task.task_id, '');

        const promise = executeTaskWithRetry(pool, scheduler, task, reports, state.run_id);
        dispatchPromises.push(promise);
      }

      // Wait for at least one task to complete before checking again
      if (dispatchPromises.length > 0) {
        await Promise.race(dispatchPromises);
      } else {
        // No tasks dispatched, wait a bit
        await sleep(100);
      }
    }

    const progress = scheduler.getProgress();
    console.log(`[ParallelDispatch] Execution complete. ${reports.length} tasks finished.`);
    eventLog(state.run_id, 'info', 'supervisor',
      `🏁 Execution complete: ${progress.completed} completed, ${progress.failed} failed`);

    return {
      reports,
      dag: scheduler.getDAG(),
      dag_progress: progress,
      worker_pool_status: pool.getStatus(),
      status: 'verifying',
      updated_at: new Date().toISOString(),
    };
  } finally {
    // Cleanup
    await pool.shutdown();
    eventLog(state.run_id, 'info', 'system', 'Worker pool shutdown');
  }
}

async function executeTaskWithRetry(
  pool: WorkerPool,
  scheduler: DAGScheduler,
  task: DAGNode,
  reports: WorkReport[],
  runId: string,
  maxRetries = 3
): Promise<void> {
  let lastError: string | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const report = await pool.executeTask(task);

    if (report) {
      reports.push(report);

      if (report.status === 'done') {
        scheduler.markCompleted(task.task_id);
        emitTaskCompletedEvent(runId, task.task_id, '', report);
        return;
      } else {
        lastError = report.error?.message ?? 'Task failed';
      }
    } else {
      lastError = 'No worker available';
    }

    // Wait before retry
    if (attempt < maxRetries - 1) {
      console.log(`[ParallelDispatch] Retrying task ${task.task_id} (attempt ${attempt + 2}/${maxRetries})`);
      await sleep(1000 * (attempt + 1));
    }
  }

  // All retries failed
  scheduler.markFailed(task.task_id, lastError);
  emitTaskFailedEvent(runId, task.task_id, '', lastError ?? 'Unknown error');
}

function setupEventHandlers(
  pool: WorkerPool,
  scheduler: DAGScheduler,
  runId: string
): void {
  pool.on('worker:created', (worker) => {
    const msg = `Worker created: ${worker.worker_id.slice(0, 8)} (${worker.executor_type})`;
    console.log(`[ParallelDispatch] ${msg}`);
    eventLog(runId, 'info', 'system', msg, { worker_id: worker.worker_id, executor_type: worker.executor_type });
  });

  pool.on('worker:idle', (worker) => {
    eventLog(runId, 'debug', worker.executor_type === 'codex' ? 'codex' : 'claude',
      `Worker ${worker.worker_id.slice(0, 8)} is now idle`, { worker_id: worker.worker_id });
  });

  pool.on('worker:busy', (worker) => {
    eventLog(runId, 'debug', worker.executor_type === 'codex' ? 'codex' : 'claude',
      `Worker ${worker.worker_id.slice(0, 8)} started working`, { worker_id: worker.worker_id });
  });

  pool.on('worker:error', (worker, error) => {
    console.error(`[ParallelDispatch] Worker error: ${worker.worker_id} - ${error}`);
    eventLog(runId, 'error', worker.executor_type === 'codex' ? 'codex' : 'claude',
      `Worker ${worker.worker_id.slice(0, 8)} error: ${error}`, { worker_id: worker.worker_id, error });
  });

  pool.on('worker:shutdown', (worker) => {
    eventLog(runId, 'info', 'system', `Worker ${worker.worker_id.slice(0, 8)} shutdown`, { worker_id: worker.worker_id });
  });

  pool.on('task:started', (taskId, workerId) => {
    const task = scheduler.getDAG().nodes.find(n => n.task_id === taskId);
    const worker = pool.getStatus().workers.find(w => w.worker_id === workerId);
    const executorType = worker?.executor_type ?? task?.executor_preference ?? 'unknown';
    const executorLabel = executorType === 'codex' ? '🟢 Codex' : executorType === 'claude' ? '🟣 Claude' : '⚪ Worker';
    eventLog(runId, 'info', 'supervisor', `▶ ${executorLabel}: ${task?.name ?? taskId}`, {
      task_id: taskId,
      worker_id: workerId,
      executor_type: executorType,
      executor_preference: task?.executor_preference,
    });
    emitTaskStartedEvent(runId, taskId, workerId);
  });

  pool.on('task:completed', (taskId, workerId, report) => {
    const task = scheduler.getDAG().nodes.find(n => n.task_id === taskId);
    const worker = pool.getStatus().workers.find(w => w.worker_id === workerId);
    const executorType = worker?.executor_type ?? 'unknown';
    const executorLabel = executorType === 'codex' ? '🟢 Codex' : executorType === 'claude' ? '🟣 Claude' : '⚪ Worker';
    eventLog(runId, 'info', 'supervisor', `✓ ${executorLabel}: ${task?.name ?? taskId}`, {
      task_id: taskId,
      worker_id: workerId,
      executor_type: executorType,
    });
    emitTaskCompletedEvent(runId, taskId, workerId, report);
  });

  pool.on('task:failed', (taskId, workerId, error) => {
    const task = scheduler.getDAG().nodes.find(n => n.task_id === taskId);
    const worker = pool.getStatus().workers.find(w => w.worker_id === workerId);
    const executorType = worker?.executor_type ?? 'unknown';
    const executorLabel = executorType === 'codex' ? '🟢 Codex' : executorType === 'claude' ? '🟣 Claude' : '⚪ Worker';
    eventLog(runId, 'error', 'supervisor', `✗ ${executorLabel}: ${task?.name ?? taskId} - ${error}`, {
      task_id: taskId,
      worker_id: workerId,
      executor_type: executorType,
      error,
    });
    emitTaskFailedEvent(runId, taskId, workerId, error);
  });
}

function emitTaskStartedEvent(runId: string, taskId: string, workerId: string): void {
  const event: ParallelDispatchEvent = {
    type: 'task_started',
    run_id: runId,
    timestamp: new Date().toISOString(),
    data: { task_id: taskId, worker_id: workerId },
  };
  parallelDispatchEvents.emit('event', event);
}

function emitTaskCompletedEvent(
  runId: string,
  taskId: string,
  workerId: string,
  report: WorkReport
): void {
  const event: ParallelDispatchEvent = {
    type: 'task_completed',
    run_id: runId,
    timestamp: new Date().toISOString(),
    data: {
      task_id: taskId,
      worker_id: workerId,
      report,
    },
  };
  parallelDispatchEvents.emit('event', event);
}

function emitTaskFailedEvent(
  runId: string,
  taskId: string,
  workerId: string,
  error: string
): void {
  const event: ParallelDispatchEvent = {
    type: 'task_failed',
    run_id: runId,
    timestamp: new Date().toISOString(),
    data: { task_id: taskId, worker_id: workerId, error },
  };
  parallelDispatchEvents.emit('event', event);
}

function emitProgressEvent(runId: string, progress: DAGProgress): void {
  const event: ParallelDispatchEvent = {
    type: 'progress',
    run_id: runId,
    timestamp: new Date().toISOString(),
    data: { progress },
  };
  parallelDispatchEvents.emit('event', event);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
