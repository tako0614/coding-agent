/**
 * WorkReport v1 - Executor → Supervisor
 * Defines the work report from an Executor back to the Supervisor
 */

export type ExecutorType = 'codex' | 'claude';
export type WorkStatus = 'done' | 'blocked' | 'failed' | 'needs_input';

export interface FileChanges {
  /** Files created during the work */
  files_created?: string[];
  /** Files modified during the work */
  files_modified?: string[];
  /** Files deleted during the work */
  files_deleted?: string[];
  /** Unified diff of all changes */
  diff_patch?: string;
}

export interface CommandResult {
  /** Command that was executed */
  cmd: string;
  /** Exit code of the command */
  exit_code: number;
  /** Standard output (may be truncated) */
  stdout?: string;
  /** Standard error (may be truncated) */
  stderr?: string;
  /** Execution time in milliseconds */
  duration_ms?: number;
}

export interface VerificationResult {
  /** Executor's self-assessment of verification (advisory only - Supervisor makes final decision) */
  passed: boolean;
  /** Details about verification results */
  details?: string;
}

export interface Question {
  /** Question requiring human decision */
  question: string;
  /** Possible answers (if applicable) */
  options?: string[];
  /** Additional context for the question */
  context?: string;
}

export interface WorkError {
  /** Error code for programmatic handling */
  code?: string;
  /** Human-readable error message */
  message?: string;
  /** Stack trace if available */
  stack?: string;
}

export interface TokenUsage {
  input?: number;
  output?: number;
}

export interface WorkReportMetadata {
  /** When the work started */
  started_at?: string;
  /** When the work completed */
  completed_at?: string;
  /** Token usage during execution */
  tokens_used?: TokenUsage;
  /** Model used by the executor */
  model?: string;
}

export interface WorkReport {
  /** Unique identifier for this report (format: wr_XXXXXXXXXXXXXXXX) */
  report_id: string;
  /** The work order this report responds to */
  order_id: string;
  /** Parent run identifier */
  run_id: string;
  /** Which executor produced this report */
  executor?: ExecutorType;
  /** Current status of the work */
  status: WorkStatus;
  /** Human-readable summary of what was done */
  summary?: string;
  /** File changes made during the work */
  changes?: FileChanges;
  /** Commands executed during the work */
  commands_run: CommandResult[];
  /** Verification results */
  verification: VerificationResult;
  /** Questions that need human input to proceed */
  questions?: Question[];
  /** Error information if status is 'failed' */
  error?: WorkError;
  /** Additional metadata */
  metadata?: WorkReportMetadata;
}

// Type guards
export function isExecutorType(value: unknown): value is ExecutorType {
  return typeof value === 'string' && ['codex', 'claude'].includes(value);
}

export function isWorkStatus(value: unknown): value is WorkStatus {
  return typeof value === 'string' &&
    ['done', 'blocked', 'failed', 'needs_input'].includes(value);
}

export function isWorkReportId(value: unknown): value is string {
  return typeof value === 'string' && /^wr_[a-zA-Z0-9]{16}$/.test(value);
}
