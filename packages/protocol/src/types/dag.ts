/**
 * DAG (Directed Acyclic Graph) Types
 * For parallel task execution with dependencies
 */

export type DAGNodeStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ExecutorPreference = 'codex' | 'claude' | 'any';

export interface DAGNode {
  /** Unique task identifier (format: task_XXXXXXXXXXXXXXXX) */
  task_id: string;
  /** Human-readable task name */
  name: string;
  /** Detailed description of what this task does */
  description: string;
  /** IDs of tasks that must complete before this one can start */
  dependencies: string[];
  /** Preferred executor type */
  executor_preference: ExecutorPreference;
  /** Priority (1-10, higher = more important) */
  priority: number;
  /** Estimated duration in milliseconds */
  estimated_duration_ms?: number;
  /** Current status */
  status: DAGNodeStatus;
  /** Assigned worker ID (when running) */
  assigned_worker_id?: string;
  /** When the task started */
  started_at?: string;
  /** When the task completed */
  completed_at?: string;
  /** Error message if failed */
  error?: string;
}

export interface DAGEdge {
  /** Source task ID (must complete first) */
  from: string;
  /** Target task ID (depends on source) */
  to: string;
}

export interface DAG {
  /** Unique DAG identifier */
  dag_id: string;
  /** Associated run ID */
  run_id: string;
  /** All tasks in the DAG */
  nodes: DAGNode[];
  /** Dependency edges */
  edges: DAGEdge[];
  /** When the DAG was created */
  created_at: string;
  /** When the DAG was last updated */
  updated_at: string;
}

export interface DAGProgress {
  /** Total number of tasks */
  total: number;
  /** Number of completed tasks */
  completed: number;
  /** Number of failed tasks */
  failed: number;
  /** Number of currently running tasks */
  running: number;
  /** Number of tasks ready to run */
  ready: number;
  /** Number of tasks waiting for dependencies */
  pending: number;
  /** Completion percentage (0-100) */
  percentage: number;
}

// Factory function
export function createTaskId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = 'task_';
  for (let i = 0; i < 16; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function createDAGId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = 'dag_';
  for (let i = 0; i < 16; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Type guard
export function isTaskId(value: unknown): value is string {
  return typeof value === 'string' && /^task_[a-zA-Z0-9]{16}$/.test(value);
}

export function isDAGId(value: unknown): value is string {
  return typeof value === 'string' && /^dag_[a-zA-Z0-9]{16}$/.test(value);
}
