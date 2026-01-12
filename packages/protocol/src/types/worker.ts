/**
 * Worker Types
 * For parallel executor pool management
 */

// =============================================================================
// Constants
// =============================================================================

/** Context truncation limit (characters) */
export const CONTEXT_TRUNCATION_LIMIT = 4_000;

/** Log preview length (characters) */
export const LOG_PREVIEW_LENGTH = 300;

// =============================================================================
// Types
// =============================================================================

export type WorkerStatus = 'idle' | 'running' | 'completed' | 'error';
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
  /** Number of tasks completed by this worker */
  completed_tasks: number;
  /** Number of failed tasks */
  failed_tasks: number;
  /** Average task duration in milliseconds */
  avg_task_duration_ms?: number;
  /** Last error message */
  last_error?: string;
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
    ['idle', 'running', 'completed', 'error'].includes(value);
}

// =============================================================================
// Cost Tracking
// =============================================================================

export interface CostMetrics {
  /** Total API calls made */
  api_calls: number;
  /** Estimated input tokens */
  input_tokens: number;
  /** Estimated output tokens */
  output_tokens: number;
  /** Estimated cost in USD */
  estimated_cost_usd: number;
  /** Breakdown by executor type */
  by_executor: Record<WorkerExecutorType, {
    api_calls: number;
    input_tokens: number;
    output_tokens: number;
    estimated_cost_usd: number;
  }>;
}

export function createEmptyCostMetrics(): CostMetrics {
  return {
    api_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_usd: 0,
    by_executor: {
      codex: { api_calls: 0, input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0 },
      claude: { api_calls: 0, input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0 },
    },
  };
}
