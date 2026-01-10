/**
 * Worker Types
 * For parallel executor pool management
 */

export type WorkerStatus = 'idle' | 'busy' | 'error' | 'shutdown' | 'starting';
export type WorkerExecutorType = 'codex' | 'claude';

export interface Worker {
  /** Unique worker identifier (format: worker_XXXXXXXXXXXXXXXX) */
  worker_id: string;
  /** Type of executor this worker uses */
  executor_type: WorkerExecutorType;
  /** Current status */
  status: WorkerStatus;
  /** Currently assigned task ID (when busy) */
  current_task_id?: string;
  /** When the worker was created */
  created_at: string;
  /** When the worker became idle (for idle timeout) */
  idle_since?: string;
  /** Number of tasks completed by this worker */
  completed_tasks: number;
  /** Number of failed tasks */
  failed_tasks: number;
  /** Average task duration in milliseconds */
  avg_task_duration_ms?: number;
  /** Last error message */
  last_error?: string;
}

export interface WorkerPoolConfig {
  /** Minimum number of workers to maintain */
  min_workers: number;
  /** Maximum number of workers allowed */
  max_workers: number;
  /** Ratio of Codex workers (0.0 - 1.0) */
  codex_ratio: number;
  /** Idle timeout before shutting down extra workers (ms) */
  idle_timeout_ms: number;
  /** Health check interval (ms) */
  health_check_interval_ms: number;
  /** Task timeout (ms) */
  task_timeout_ms: number;
  /** Max retries for failed tasks */
  max_task_retries: number;
}

export interface WorkerPoolStatus {
  /** Total number of active workers */
  total_workers: number;
  /** Number of idle workers */
  idle_workers: number;
  /** Number of busy workers */
  busy_workers: number;
  /** Number of workers in error state */
  error_workers: number;
  /** All worker details */
  workers: Worker[];
  /** Pool configuration */
  config: WorkerPoolConfig;
  /** Total tasks completed by the pool */
  total_tasks_completed: number;
  /** Total tasks failed */
  total_tasks_failed: number;
}

export interface WorkerTaskAssignment {
  /** Worker ID */
  worker_id: string;
  /** Task ID */
  task_id: string;
  /** When the assignment was made */
  assigned_at: string;
  /** Timeout for this assignment */
  timeout_at: string;
}

// Factory function
export function createWorkerId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = 'worker_';
  for (let i = 0; i < 16; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Type guard
export function isWorkerId(value: unknown): value is string {
  return typeof value === 'string' && /^worker_[a-zA-Z0-9]{16}$/.test(value);
}

export function isWorkerExecutorType(value: unknown): value is WorkerExecutorType {
  return value === 'codex' || value === 'claude';
}

export function isWorkerStatus(value: unknown): value is WorkerStatus {
  return typeof value === 'string' &&
    ['idle', 'busy', 'error', 'shutdown', 'starting'].includes(value);
}

// Default configuration
export const DEFAULT_WORKER_POOL_CONFIG: WorkerPoolConfig = {
  min_workers: 5,
  max_workers: 20,
  codex_ratio: 0.6,
  idle_timeout_ms: 60000,        // 1 minute
  health_check_interval_ms: 10000, // 10 seconds
  task_timeout_ms: 300000,       // 5 minutes
  max_task_retries: 3,
};
