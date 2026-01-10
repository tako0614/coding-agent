/**
 * WorkOrder v1 - Supervisor → Executor
 * Defines the work instruction from Supervisor to an Executor (Claude Code / Codex)
 */

export type TaskKind = 'spec' | 'implement' | 'debug' | 'refactor' | 'test' | 'review';
export type DependencyPolicy = 'allow' | 'existing_only' | 'deny';
export type NetworkPolicy = 'allow' | 'deny';

export interface RepoInfo {
  /** Absolute or relative path to the repository */
  path: string;
  /** Target branch for changes */
  branch?: string;
  /** Base commit SHA for diff tracking */
  base_commit?: string;
}

export interface Constraints {
  /** Glob patterns for paths the executor may modify */
  allowed_paths?: string[];
  /** Glob patterns for paths the executor must NOT modify */
  forbidden_paths?: string[];
  /** Policy for adding new dependencies */
  dependency_policy?: DependencyPolicy;
  /** Policy for network access during execution */
  network_policy?: NetworkPolicy;
}

export interface VerificationCommand {
  /** Command to run for verification */
  cmd: string;
  /** Working directory for the command (relative to repo.path) */
  working_dir?: string;
  /** Whether this command must succeed for verification to pass */
  must_pass?: boolean;
  /** Timeout in milliseconds */
  timeout_ms?: number;
}

export interface Verification {
  /** Commands to run for automated verification */
  commands: VerificationCommand[];
}

export interface RateLimit {
  max_tokens_per_minute?: number;
  max_requests_per_minute?: number;
}

export interface Tooling {
  /** Whether to run in sandbox mode */
  sandbox?: boolean;
  /** Whether to require manual approval for dangerous operations */
  approval_required?: boolean;
  /** Directories where file writes are allowed */
  write_roots?: string[];
  /** Rate limiting configuration */
  rate_limit?: RateLimit;
}

export interface WorkOrderMetadata {
  /** When the work order was created */
  created_at?: string;
  /** Priority (1-10, default 5) */
  priority?: number;
  /** Current retry count */
  retry_count?: number;
  /** Maximum number of retries */
  max_retries?: number;
}

export interface WorkOrder {
  /** Unique identifier for this work order (format: wo_XXXXXXXXXXXXXXXX) */
  order_id: string;
  /** Parent run identifier (format: run_XXXXXXXXXXXXXXXX) */
  run_id: string;
  /** Parent work order ID (for debug/follow-up orders) */
  parent_order_id?: string;
  /** Type of task to perform */
  task_kind: TaskKind;
  /** Repository information */
  repo: RepoInfo;
  /** Clear description of what needs to be done */
  objective: string;
  /** Context, previous attempts, error logs (especially for debug tasks) */
  background?: string;
  /** Constraints on what the executor can do */
  constraints?: Constraints;
  /** List of criteria that must be met for the task to be considered complete */
  acceptance_criteria: string[];
  /** Verification configuration */
  verification: Verification;
  /** Tooling configuration */
  tooling: Tooling;
  /** Additional metadata */
  metadata?: WorkOrderMetadata;
}

// Type guards
export function isTaskKind(value: unknown): value is TaskKind {
  return typeof value === 'string' &&
    ['spec', 'implement', 'debug', 'refactor', 'test', 'review'].includes(value);
}

export function isWorkOrderId(value: unknown): value is string {
  return typeof value === 'string' && /^wo_[a-zA-Z0-9]{16}$/.test(value);
}

export function isRunId(value: unknown): value is string {
  return typeof value === 'string' && /^run_[a-zA-Z0-9]{16}$/.test(value);
}
