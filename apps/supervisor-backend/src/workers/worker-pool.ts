/**
 * WorkerPool - Manages multiple worker instances
 * Handles scaling, health checks, and task assignment
 */

import type {
  Worker,
  WorkerPoolConfig,
  WorkerPoolStatus,
  WorkerExecutorType,
  DAGNode,
  WorkReport,
  DAG,
} from '@supervisor/protocol';
import { DEFAULT_WORKER_POOL_CONFIG } from '@supervisor/protocol';
import { WorkerInstance, createWorkerInstance, type TaskContext } from './worker-instance.js';
import { EventEmitter } from 'events';

export type ExecutorMode = 'agent' | 'codex_only' | 'claude_only';

export interface PoolContext {
  userGoal: string;
  repoContext?: string;
  dag?: DAG;
  executorMode?: ExecutorMode;
}

export interface WorkerPoolEvents {
  'worker:created': (worker: Worker) => void;
  'worker:idle': (worker: Worker) => void;
  'worker:busy': (worker: Worker) => void;
  'worker:error': (worker: Worker, error: string) => void;
  'worker:shutdown': (worker: Worker) => void;
  'task:started': (taskId: string, workerId: string) => void;
  'task:completed': (taskId: string, workerId: string, report: WorkReport) => void;
  'task:failed': (taskId: string, workerId: string, error: string) => void;
}

export class WorkerPool extends EventEmitter {
  private workers: Map<string, WorkerInstance> = new Map();
  private config: WorkerPoolConfig;
  private repoPath: string;
  private runId: string;
  private healthCheckInterval?: NodeJS.Timeout;
  private totalTasksCompleted = 0;
  private totalTasksFailed = 0;
  private isShuttingDown = false;
  private poolContext: PoolContext;
  private completedTasks: Map<string, string> = new Map(); // taskId -> summary

  constructor(
    config: Partial<WorkerPoolConfig>,
    repoPath: string,
    runId: string,
    poolContext?: PoolContext
  ) {
    super();
    this.config = { ...DEFAULT_WORKER_POOL_CONFIG, ...config };
    this.repoPath = repoPath;
    this.runId = runId;
    this.poolContext = poolContext ?? { userGoal: '' };
  }

  /**
   * Update pool context (e.g., when DAG is built)
   */
  updateContext(context: Partial<PoolContext>): void {
    this.poolContext = { ...this.poolContext, ...context };
  }

  /**
   * Initialize the worker pool with minimum workers
   */
  async initialize(): Promise<void> {
    const executorMode = this.poolContext.executorMode ?? 'agent';
    console.log(`[WorkerPool] Initializing with ${this.config.min_workers} workers (mode: ${executorMode})`);

    const createPromises: Promise<void>[] = [];

    if (executorMode === 'codex_only') {
      // Only create Codex workers
      for (let i = 0; i < this.config.min_workers; i++) {
        createPromises.push(this.createWorker('codex'));
      }
    } else if (executorMode === 'claude_only') {
      // Only create Claude workers
      for (let i = 0; i < this.config.min_workers; i++) {
        createPromises.push(this.createWorker('claude'));
      }
    } else {
      // Agent mode: Create workers based on DAG executor preferences
      // Analyze DAG to determine initial worker distribution
      const dag = this.poolContext.dag;
      if (dag && dag.nodes.length > 0) {
        const codexTasks = dag.nodes.filter(n => n.executor_preference === 'codex').length;
        const claudeTasks = dag.nodes.filter(n => n.executor_preference === 'claude').length;
        const totalTasks = codexTasks + claudeTasks || 1;
        const codexRatio = codexTasks / totalTasks;
        const codexCount = Math.max(1, Math.floor(this.config.min_workers * codexRatio));
        const claudeCount = Math.max(1, this.config.min_workers - codexCount);

        for (let i = 0; i < codexCount; i++) {
          createPromises.push(this.createWorker('codex'));
        }
        for (let i = 0; i < claudeCount; i++) {
          createPromises.push(this.createWorker('claude'));
        }
      } else {
        // No DAG yet, create balanced workers
        const codexCount = Math.ceil(this.config.min_workers / 2);
        const claudeCount = this.config.min_workers - codexCount;
        for (let i = 0; i < codexCount; i++) {
          createPromises.push(this.createWorker('codex'));
        }
        for (let i = 0; i < claudeCount; i++) {
          createPromises.push(this.createWorker('claude'));
        }
      }
    }

    await Promise.all(createPromises);

    // Start health check interval
    this.startHealthCheck();

    console.log(`[WorkerPool] Initialized with ${this.workers.size} workers`);
  }

  /**
   * Create a new worker
   */
  private async createWorker(executorType: WorkerExecutorType): Promise<void> {
    const instance = createWorkerInstance({
      executorType,
      repoPath: this.repoPath,
      runId: this.runId,
    });

    const success = await instance.initialize();
    if (success) {
      this.workers.set(instance.getId(), instance);
      this.emit('worker:created', instance.getWorker());
      console.log(`[WorkerPool] Created ${executorType} worker: ${instance.getId()}`);
    } else {
      console.warn(`[WorkerPool] Failed to create ${executorType} worker`);
    }
  }

  /**
   * Get an idle worker, optionally with executor preference
   */
  async getIdleWorker(preference?: WorkerExecutorType): Promise<WorkerInstance | null> {
    // First try to find a worker with the preferred executor type
    if (preference) {
      for (const [, instance] of this.workers) {
        if (instance.isIdle() && instance.getExecutorType() === preference) {
          return instance;
        }
      }
    }

    // Fall back to any idle worker
    for (const [, instance] of this.workers) {
      if (instance.isIdle()) {
        return instance;
      }
    }

    // If we can scale up, try to create a new worker
    if (this.workers.size < this.config.max_workers) {
      const executorType = preference ?? this.getNeededExecutorType();
      await this.createWorker(executorType);

      // Try to find the newly created idle worker
      for (const [, instance] of this.workers) {
        if (instance.isIdle()) {
          return instance;
        }
      }
    }

    return null;
  }

  /**
   * Determine which executor type is needed based on current ratio and executor mode
   */
  private getNeededExecutorType(): WorkerExecutorType {
    const executorMode = this.poolContext.executorMode ?? 'agent';

    // If mode is specific, only return that type
    if (executorMode === 'codex_only') return 'codex';
    if (executorMode === 'claude_only') return 'claude';

    // Agent mode: balance based on current worker distribution
    let codexCount = 0;
    let claudeCount = 0;

    for (const [, instance] of this.workers) {
      if (instance.getExecutorType() === 'codex') {
        codexCount++;
      } else {
        claudeCount++;
      }
    }

    // Try to maintain balance
    return codexCount <= claudeCount ? 'codex' : 'claude';
  }

  /**
   * Execute a task on a worker
   */
  async executeTask(node: DAGNode): Promise<WorkReport | null> {
    const executorPref = node.executor_preference === 'any' ? undefined : node.executor_preference;
    const worker = await this.getIdleWorker(executorPref);

    if (!worker) {
      return null;
    }

    this.emit('worker:busy', worker.getWorker());
    this.emit('task:started', node.task_id, worker.getId());

    // Build task context for the worker
    const taskContext: TaskContext = {
      userGoal: this.poolContext.userGoal,
      repoContext: this.poolContext.repoContext,
      dag: this.poolContext.dag,
      completedTasks: Object.fromEntries(this.completedTasks),
    };

    try {
      const result = await worker.executeTask(node, taskContext);

      if (result.success && result.report) {
        this.totalTasksCompleted++;
        // Track completed task summary for future context
        this.completedTasks.set(node.task_id, result.report.summary || `Completed: ${node.name}`);
        this.emit('task:completed', node.task_id, worker.getId(), result.report);
        this.emit('worker:idle', worker.getWorker());
        return result.report;
      } else {
        this.totalTasksFailed++;
        this.emit('task:failed', node.task_id, worker.getId(), result.error ?? 'Unknown error');

        if (worker.isError()) {
          this.emit('worker:error', worker.getWorker(), result.error ?? 'Unknown error');
        } else {
          this.emit('worker:idle', worker.getWorker());
        }

        return result.report ?? null;
      }
    } catch (error) {
      this.totalTasksFailed++;
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.emit('task:failed', node.task_id, worker.getId(), errorMsg);
      this.emit('worker:error', worker.getWorker(), errorMsg);
      return null;
    }
  }

  /**
   * Get pool status
   */
  getStatus(): WorkerPoolStatus {
    const workers: Worker[] = [];
    let idleCount = 0;
    let busyCount = 0;
    let errorCount = 0;

    for (const [, instance] of this.workers) {
      const worker = instance.getWorker();
      workers.push(worker);

      switch (worker.status) {
        case 'idle':
          idleCount++;
          break;
        case 'busy':
          busyCount++;
          break;
        case 'error':
          errorCount++;
          break;
      }
    }

    return {
      total_workers: this.workers.size,
      idle_workers: idleCount,
      busy_workers: busyCount,
      error_workers: errorCount,
      workers,
      config: this.config,
      total_tasks_completed: this.totalTasksCompleted,
      total_tasks_failed: this.totalTasksFailed,
    };
  }

  /**
   * Get number of idle workers
   */
  getIdleCount(): number {
    let count = 0;
    for (const [, instance] of this.workers) {
      if (instance.isIdle()) {
        count++;
      }
    }
    return count;
  }

  /**
   * Get number of busy workers
   */
  getBusyCount(): number {
    let count = 0;
    for (const [, instance] of this.workers) {
      if (instance.getStatus() === 'busy') {
        count++;
      }
    }
    return count;
  }

  /**
   * Start health check interval
   */
  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, this.config.health_check_interval_ms);
  }

  /**
   * Perform health check on all workers
   */
  private async performHealthCheck(): Promise<void> {
    if (this.isShuttingDown) return;

    const promises: Promise<void>[] = [];

    for (const [id, instance] of this.workers) {
      // Try to recover error workers
      if (instance.isError()) {
        promises.push(
          instance.recover().then((success) => {
            if (success) {
              console.log(`[WorkerPool] Worker ${id} recovered`);
              this.emit('worker:idle', instance.getWorker());
            }
          })
        );
      }

      // Shutdown idle workers that have been idle too long (if above minimum)
      if (
        instance.isIdle() &&
        this.workers.size > this.config.min_workers &&
        instance.getIdleDuration() > this.config.idle_timeout_ms
      ) {
        console.log(`[WorkerPool] Shutting down idle worker ${id}`);
        instance.shutdown();
        this.emit('worker:shutdown', instance.getWorker());
        this.workers.delete(id);
      }
    }

    await Promise.all(promises);

    // Ensure minimum workers
    if (this.workers.size < this.config.min_workers) {
      const needed = this.config.min_workers - this.workers.size;
      for (let i = 0; i < needed; i++) {
        await this.createWorker(this.getNeededExecutorType());
      }
    }
  }

  /**
   * Shutdown the pool
   */
  async shutdown(): Promise<void> {
    console.log('[WorkerPool] Shutting down...');
    this.isShuttingDown = true;

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    for (const [id, instance] of this.workers) {
      instance.shutdown();
      this.emit('worker:shutdown', instance.getWorker());
      this.workers.delete(id);
    }

    console.log('[WorkerPool] Shutdown complete');
  }

  /**
   * Scale up the pool by adding more workers
   */
  async scaleUp(count: number): Promise<void> {
    const targetSize = Math.min(
      this.workers.size + count,
      this.config.max_workers
    );
    const toCreate = targetSize - this.workers.size;

    for (let i = 0; i < toCreate; i++) {
      await this.createWorker(this.getNeededExecutorType());
    }
  }

  /**
   * Scale down the pool by removing idle workers
   */
  scaleDown(count: number): void {
    let removed = 0;
    const minSize = this.config.min_workers;

    for (const [id, instance] of this.workers) {
      if (removed >= count) break;
      if (this.workers.size <= minSize) break;

      if (instance.isIdle()) {
        instance.shutdown();
        this.emit('worker:shutdown', instance.getWorker());
        this.workers.delete(id);
        removed++;
      }
    }
  }
}

/**
 * Create a new worker pool
 */
export function createWorkerPool(
  config: Partial<WorkerPoolConfig>,
  repoPath: string,
  runId: string,
  poolContext?: PoolContext
): WorkerPool {
  return new WorkerPool(config, repoPath, runId, poolContext);
}
