/**
 * WorkerPool - Manages worker instances for task execution
 * Workers can be reused across multiple tasks
 */

import type {
  Worker,
  WorkerExecutorType,
  DAGNode,
  WorkReport,
  DAG,
} from '@supervisor/protocol';
import { WorkerInstance, createWorkerInstance, type TaskContext } from './worker-instance.js';
import { EventEmitter } from 'events';
import { logger } from '../services/logger.js';
import { getErrorMessage } from '../services/errors.js';

export type ExecutorMode = 'agent' | 'codex_only' | 'claude_only' | 'claude_direct' | 'codex_direct';

/** Default task timeout in ms (10 minutes) */
const DEFAULT_TASK_TIMEOUT_MS = parseInt(process.env['WORKER_TASK_TIMEOUT_MS'] ?? String(10 * 60 * 1000), 10);

/** Maximum time to wait for an idle worker in ms (5 minutes) */
const WORKER_WAIT_TIMEOUT_MS = parseInt(process.env['WORKER_WAIT_TIMEOUT_MS'] ?? String(5 * 60 * 1000), 10);

export interface PoolContext {
  userGoal: string;
  repoContext?: string;
  dag?: DAG;
  executorMode?: ExecutorMode;
}

export interface WorkerPoolEvents {
  'worker:created': (worker: Worker) => void;
  'worker:completed': (worker: Worker) => void;
  'worker:error': (worker: Worker, error: string) => void;
  'task:started': (taskId: string, workerId: string) => void;
  'task:completed': (taskId: string, workerId: string, report: WorkReport) => void;
  'task:failed': (taskId: string, workerId: string, error: string) => void;
}

export class WorkerPool extends EventEmitter {
  /** Multiple workers per executor type for true parallelism */
  private workers: Map<WorkerExecutorType, WorkerInstance[]> = new Map();
  private repoPath: string;
  private runId: string;
  private totalTasksCompleted = 0;
  private totalTasksFailed = 0;
  private poolContext: PoolContext;
  private completedTasks: Map<string, string> = new Map(); // taskId -> summary
  private cancelled = false;
  private abortController: AbortController;
  /** Pending worker requests waiting for idle workers - using Map for O(1) removal */
  private pendingWorkerRequests: Map<WorkerExecutorType, Map<number, {
    resolve: (worker: WorkerInstance | null) => void;
    reject: (error: Error) => void;
    timeoutId: NodeJS.Timeout;
  }>> = new Map();
  /** Unique ID counter for pending requests */
  private pendingRequestIdCounter = 0;

  constructor(
    repoPath: string,
    runId: string,
    poolContext?: PoolContext
  ) {
    super();
    this.repoPath = repoPath;
    this.runId = runId;
    this.poolContext = poolContext ?? { userGoal: '' };
    this.abortController = new AbortController();

    // Handle EventEmitter 'error' event to prevent Node.js from throwing
    this.on('error', (error: Error) => {
      logger.error('WorkerPool error event', {
        runId: this.runId,
        error: error.message,
      });
    });
  }

  /**
   * Update pool context
   */
  updateContext(context: Partial<PoolContext>): void {
    this.poolContext = { ...this.poolContext, ...context };
  }

  /**
   * Initialize the worker pool
   */
  async initialize(): Promise<void> {
    logger.info('WorkerPool initialized', {
      runId: this.runId,
      mode: this.poolContext.executorMode ?? 'agent',
    });
  }

  /**
   * Cancel all running tasks
   */
  cancel(): void {
    this.cancelled = true;
    this.abortController.abort();
    logger.warn('WorkerPool cancelled', { runId: this.runId });
  }

  /**
   * Get the abort signal for this pool
   */
  getAbortSignal(): AbortSignal {
    return this.abortController.signal;
  }

  /**
   * Check if pool is cancelled
   */
  isCancelled(): boolean {
    return this.cancelled;
  }

  /**
   * Get executor type for a task based on mode and preference
   */
  private getExecutorType(preference?: WorkerExecutorType): WorkerExecutorType {
    const mode = this.poolContext.executorMode ?? 'agent';

    if (mode === 'codex_only') return 'codex';
    if (mode === 'claude_only') return 'claude';

    // Agent mode: respect task preference or use codex as default
    return preference ?? 'codex';
  }

  /**
   * Get an idle worker or create a new one for the given executor type
   * Returns the first idle worker, or creates a new one if under the limit
   * Returns null if all workers are busy and at capacity
   */
  private getOrCreateWorker(executorType: WorkerExecutorType): WorkerInstance | null {
    let workerPool = this.workers.get(executorType);

    if (!workerPool) {
      workerPool = [];
      this.workers.set(executorType, workerPool);
    }

    // First, try to find an idle worker
    for (const worker of workerPool) {
      if (worker.isIdle()) {
        return worker;
      }
    }

    // No idle worker, create a new one (no limit)
    const newWorker = createWorkerInstance({
      executorType,
      repoPath: this.repoPath,
      runId: this.runId,
    });
    workerPool.push(newWorker);
    this.emit('worker:created', newWorker.getWorker());
    logger.debug('Created new worker', {
      runId: this.runId,
      executorType,
      poolSize: workerPool.length,
    });
    return newWorker;
  }

  /**
   * Wait for a worker to become available (event-based, not polling)
   */
  private async waitForIdleWorker(executorType: WorkerExecutorType): Promise<WorkerInstance | null> {
    const workerPool = this.workers.get(executorType);
    if (!workerPool || workerPool.length === 0) {
      return null;
    }

    // Check if already aborted
    if (this.cancelled || this.abortController.signal.aborted) {
      return null;
    }

    // First, check if there's an idle worker available right now
    for (const worker of workerPool) {
      if (worker.isIdle()) {
        return worker;
      }
    }

    // No idle worker, wait for one to become available via event
    const maxWait = WORKER_WAIT_TIMEOUT_MS;

    // Generate unique request ID upfront for O(1) removal
    const requestId = this.pendingRequestIdCounter++;

    return new Promise<WorkerInstance | null>((resolve, reject) => {
      // Track abort handler for cleanup
      let abortHandler: (() => void) | null = null;

      // Set up timeout
      const timeoutId = setTimeout(() => {
        // Remove from pending requests (O(1) operation)
        this.removePendingRequest(executorType, requestId);
        // Remove abort listener to prevent memory leak
        if (abortHandler) {
          this.abortController.signal.removeEventListener('abort', abortHandler);
        }
        logger.warn('Timeout waiting for idle worker', {
          runId: this.runId,
          executorType,
          waitedMs: maxWait,
        });
        resolve(null);
      }, maxWait);

      // Set up abort handler
      abortHandler = () => {
        clearTimeout(timeoutId);
        this.removePendingRequest(executorType, requestId);
        resolve(null);
      };
      this.abortController.signal.addEventListener('abort', abortHandler, { once: true });

      // Wrapped resolve that cleans up resources
      const wrappedResolve = (worker: WorkerInstance | null) => {
        clearTimeout(timeoutId);
        if (abortHandler) {
          this.abortController.signal.removeEventListener('abort', abortHandler);
        }
        resolve(worker);
      };

      // Add to pending requests queue (using Map for O(1) removal)
      let pendingQueue = this.pendingWorkerRequests.get(executorType);
      if (!pendingQueue) {
        pendingQueue = new Map();
        this.pendingWorkerRequests.set(executorType, pendingQueue);
      }
      pendingQueue.set(requestId, {
        resolve: wrappedResolve,
        reject,
        timeoutId,
      });
    });
  }

  /**
   * Remove a pending request from the queue by ID (O(1) operation)
   */
  private removePendingRequest(
    executorType: WorkerExecutorType,
    requestId: number
  ): void {
    const pendingQueue = this.pendingWorkerRequests.get(executorType);
    if (pendingQueue) {
      pendingQueue.delete(requestId);  // O(1) deletion
    }
  }

  /**
   * Notify waiting tasks that a worker is now available
   */
  private notifyWorkerAvailable(executorType: WorkerExecutorType, worker: WorkerInstance): void {
    const pendingQueue = this.pendingWorkerRequests.get(executorType);
    if (pendingQueue && pendingQueue.size > 0) {
      // Get first (oldest) entry from the Map
      const firstEntry = pendingQueue.entries().next();
      if (!firstEntry.done) {
        const [id, pending] = firstEntry.value;
        pendingQueue.delete(id);
        clearTimeout(pending.timeoutId);
        pending.resolve(worker);
      }
    }
  }

  /**
   * Update status counters
   * Note: No lock needed - Node.js synchronous code is atomic
   */
  private updateTaskStats(success: boolean, taskId: string, summary?: string): void {
    if (success) {
      this.totalTasksCompleted++;
      if (summary) {
        this.completedTasks.set(taskId, summary);
      }
    } else {
      this.totalTasksFailed++;
    }
  }

  /**
   * Execute a task using a worker (reuses existing workers)
   */
  async executeTask(node: DAGNode, timeoutMs?: number): Promise<WorkReport | null> {
    // Check for cancellation or abort
    if (this.cancelled || this.abortController.signal.aborted) {
      logger.info('Task skipped due to cancellation', { taskId: node.task_id });
      return null;
    }

    const executorType = this.getExecutorType(
      node.executor_preference === 'any' ? undefined : node.executor_preference
    );

    try {
      // Get or create worker for this executor type
      let worker = this.getOrCreateWorker(executorType);

      // If no worker available, wait for one
      if (!worker) {
        logger.debug('Waiting for idle worker', { taskId: node.task_id, executorType });
        worker = await this.waitForIdleWorker(executorType);
        if (!worker) {
          logger.error('No worker available after waiting', { taskId: node.task_id, executorType });
          this.updateTaskStats(false, node.task_id);
          this.emit('task:failed', node.task_id, '', 'No worker available');
          return null;
        }
      }

      // Check if executor is available
      const available = await worker.isAvailable();
      if (!available) {
        logger.error('Executor not available', { executorType, runId: this.runId });
        this.updateTaskStats(false, node.task_id);
        this.emit('task:failed', node.task_id, '', 'Executor not available');
        return null;
      }

      this.emit('task:started', node.task_id, worker.getId());

      // Build task context
      const taskContext: TaskContext = {
        userGoal: this.poolContext.userGoal,
        repoContext: this.poolContext.repoContext,
        dag: this.poolContext.dag,
        completedTasks: Object.fromEntries(this.completedTasks),
      };

      // Execute with timeout and abort signal
      const effectiveTimeout = timeoutMs ?? node.estimated_duration_ms ?? DEFAULT_TASK_TIMEOUT_MS;
      const result = await withTimeoutAndAbort(
        worker.executeTask(node, taskContext),
        effectiveTimeout,
        this.abortController.signal,
        node.task_id
      );

      if (result.success && result.report) {
        this.updateTaskStats(true, node.task_id, result.report.summary || `Completed: ${node.name}`);
        this.emit('task:completed', node.task_id, worker.getId(), result.report);
        this.emit('worker:completed', worker.getWorker());
        // Notify pending tasks that this worker is now available
        this.notifyWorkerAvailable(executorType, worker);
        return result.report;
      } else {
        this.updateTaskStats(false, node.task_id);
        const error = result.error ?? 'Unknown error';
        this.emit('task:failed', node.task_id, worker.getId(), error);
        this.emit('worker:error', worker.getWorker(), error);
        // Even on failure, worker becomes available
        this.notifyWorkerAvailable(executorType, worker);
        return result.report ?? null;
      }
    } catch (error) {
      this.updateTaskStats(false, node.task_id);
      const errorMsg = getErrorMessage(error);
      this.emit('task:failed', node.task_id, '', errorMsg);
      logger.error('Task execution error', { taskId: node.task_id, error: errorMsg });
      return null;
    }
  }

  /**
   * Get pool status
   */
  getStatus() {
    const workerList: Worker[] = [];
    let idleCount = 0;
    let busyCount = 0;

    // Single pass: collect workers and count statuses
    for (const workers of this.workers.values()) {
      for (const w of workers) {
        const worker = w.getWorker();
        workerList.push(worker);
        if (worker.status === 'idle') {
          idleCount++;
        } else if (worker.status === 'running') {
          busyCount++;
        }
      }
    }

    return {
      total_workers: workerList.length,
      idle_workers: idleCount,
      busy_workers: busyCount,
      workers: workerList,
      total_tasks_completed: this.totalTasksCompleted,
      total_tasks_failed: this.totalTasksFailed,
    };
  }

  /**
   * Shutdown the pool and dispose all workers
   */
  async shutdown(): Promise<void> {
    logger.info('WorkerPool shutdown', {
      runId: this.runId,
      completed: this.totalTasksCompleted,
      failed: this.totalTasksFailed,
    });

    // Cancel all operations
    this.cancelled = true;
    this.abortController.abort();

    // Clean up pending worker requests
    for (const [executorType, pendingQueue] of this.pendingWorkerRequests.entries()) {
      for (const [, pending] of pendingQueue) {
        clearTimeout(pending.timeoutId);
        // Resolve with null to unblock waiting callers
        try {
          pending.resolve(null);
        } catch (err) {
          logger.debug('Error resolving pending request during shutdown', {
            runId: this.runId,
            executorType,
            error: getErrorMessage(err),
          });
        }
      }
    }
    this.pendingWorkerRequests.clear();

    // Dispose all workers with error handling for each
    const errors: string[] = [];
    for (const [executorType, workerArray] of this.workers.entries()) {
      for (const worker of workerArray) {
        try {
          worker.dispose();
        } catch (error) {
          const errorMsg = getErrorMessage(error);
          errors.push(`${executorType}: ${errorMsg}`);
          logger.error('Failed to dispose worker', {
            runId: this.runId,
            executorType,
            error: errorMsg,
          });
        }
      }
    }
    this.workers.clear();

    // Remove all EventEmitter listeners
    this.removeAllListeners();

    if (errors.length > 0) {
      logger.warn('WorkerPool shutdown completed with errors', {
        runId: this.runId,
        errors,
      });
    }
  }
}

/**
 * Helper to race a promise against a timeout and abort signal
 */
async function withTimeoutAndAbort<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  taskId: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // Check if already aborted
    if (signal.aborted) {
      reject(new Error('Task aborted'));
      return;
    }

    const timeoutId = setTimeout(() => {
      reject(new Error(`Task ${taskId} timed out after ${Math.round(timeoutMs / 60000)} minutes`));
    }, timeoutMs);

    const abortHandler = () => {
      clearTimeout(timeoutId);
      reject(new Error('Task aborted'));
    };

    signal.addEventListener('abort', abortHandler, { once: true });

    promise
      .then((result) => {
        clearTimeout(timeoutId);
        signal.removeEventListener('abort', abortHandler);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        signal.removeEventListener('abort', abortHandler);
        reject(error);
      });
  });
}

/**
 * Create a new worker pool
 */
export function createWorkerPool(
  repoPath: string,
  runId: string,
  poolContext?: PoolContext
): WorkerPool {
  return new WorkerPool(repoPath, runId, poolContext);
}
