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
  CostMetrics,
} from '@supervisor/protocol';
import { createEmptyCostMetrics } from '@supervisor/protocol';
import { WorkerInstance, createWorkerInstance, type TaskContext } from './worker-instance.js';
import { EventEmitter } from 'events';
import { logger } from '../services/logger.js';

export type ExecutorMode = 'agent' | 'codex_only' | 'claude_only';

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
  private workers: Map<WorkerExecutorType, WorkerInstance> = new Map();
  private repoPath: string;
  private runId: string;
  private totalTasksCompleted = 0;
  private totalTasksFailed = 0;
  private poolContext: PoolContext;
  private completedTasks: Map<string, string> = new Map(); // taskId -> summary
  private costMetrics: CostMetrics;
  private cancelled = false;

  constructor(
    repoPath: string,
    runId: string,
    poolContext?: PoolContext
  ) {
    super();
    this.repoPath = repoPath;
    this.runId = runId;
    this.poolContext = poolContext ?? { userGoal: '' };
    this.costMetrics = createEmptyCostMetrics();
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
    logger.warn('WorkerPool cancelled', { runId: this.runId });
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
   * Get or create a worker for the given executor type
   */
  private getOrCreateWorker(executorType: WorkerExecutorType): WorkerInstance {
    let worker = this.workers.get(executorType);

    if (!worker) {
      worker = createWorkerInstance({
        executorType,
        repoPath: this.repoPath,
        runId: this.runId,
      });
      this.workers.set(executorType, worker);
      this.emit('worker:created', worker.getWorker());
    }

    return worker;
  }

  /**
   * Update cost metrics from a work report
   */
  private updateCostMetrics(report: WorkReport, executorType: WorkerExecutorType): void {
    const metadata = report.metadata as Record<string, unknown> | undefined;
    const inputTokens = (metadata?.['input_tokens'] as number) ?? 0;
    const outputTokens = (metadata?.['output_tokens'] as number) ?? 0;

    // Estimate costs (rough estimates)
    const costPerInputToken = executorType === 'claude' ? 0.000003 : 0.000001;
    const costPerOutputToken = executorType === 'claude' ? 0.000015 : 0.000002;
    const cost = inputTokens * costPerInputToken + outputTokens * costPerOutputToken;

    this.costMetrics.api_calls++;
    this.costMetrics.input_tokens += inputTokens;
    this.costMetrics.output_tokens += outputTokens;
    this.costMetrics.estimated_cost_usd += cost;

    this.costMetrics.by_executor[executorType].api_calls++;
    this.costMetrics.by_executor[executorType].input_tokens += inputTokens;
    this.costMetrics.by_executor[executorType].output_tokens += outputTokens;
    this.costMetrics.by_executor[executorType].estimated_cost_usd += cost;
  }

  /**
   * Execute a task using a worker (reuses existing workers)
   */
  async executeTask(node: DAGNode): Promise<WorkReport | null> {
    // Check for cancellation
    if (this.cancelled) {
      logger.info('Task skipped due to cancellation', { taskId: node.task_id });
      return null;
    }

    const executorType = this.getExecutorType(
      node.executor_preference === 'any' ? undefined : node.executor_preference
    );

    try {
      // Get or create worker for this executor type
      const worker = this.getOrCreateWorker(executorType);

      // Check if executor is available
      const available = await worker.isAvailable();
      if (!available) {
        logger.error('Executor not available', { executorType, runId: this.runId });
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

      const result = await worker.executeTask(node, taskContext);

      if (result.success && result.report) {
        this.totalTasksCompleted++;
        this.completedTasks.set(node.task_id, result.report.summary || `Completed: ${node.name}`);
        this.updateCostMetrics(result.report, executorType);
        this.emit('task:completed', node.task_id, worker.getId(), result.report);
        this.emit('worker:completed', worker.getWorker());
        return result.report;
      } else {
        this.totalTasksFailed++;
        const error = result.error ?? 'Unknown error';
        if (result.report) {
          this.updateCostMetrics(result.report, executorType);
        }
        this.emit('task:failed', node.task_id, worker.getId(), error);
        this.emit('worker:error', worker.getWorker(), error);
        return result.report ?? null;
      }
    } catch (error) {
      this.totalTasksFailed++;
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.emit('task:failed', node.task_id, '', errorMsg);
      logger.error('Task execution error', { taskId: node.task_id, error: errorMsg });
      return null;
    }
  }

  /**
   * Get pool status
   */
  getStatus() {
    const workerList = Array.from(this.workers.values()).map(w => w.getWorker());

    return {
      total_workers: workerList.length,
      workers: workerList,
      total_tasks_completed: this.totalTasksCompleted,
      total_tasks_failed: this.totalTasksFailed,
    };
  }

  /**
   * Get cost metrics
   */
  getCostMetrics(): CostMetrics {
    return { ...this.costMetrics };
  }

  /**
   * Shutdown the pool and dispose all workers
   */
  async shutdown(): Promise<void> {
    logger.info('WorkerPool shutdown', {
      runId: this.runId,
      completed: this.totalTasksCompleted,
      failed: this.totalTasksFailed,
      costMetrics: this.costMetrics,
    });

    // Dispose all workers
    for (const worker of this.workers.values()) {
      worker.dispose();
    }
    this.workers.clear();
  }
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
