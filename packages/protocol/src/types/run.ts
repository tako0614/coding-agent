/**
 * Run - Top-level execution unit
 * Represents a single user request from start to completion
 */

import type { WorkOrder } from './work-order.js';
import type { WorkReport } from './work-report.js';

export type RunStatus = 'pending' | 'running' | 'verifying' | 'debugging' | 'needs_input' | 'completed' | 'failed' | 'cancelled';

export interface ModelPolicy {
  /** Primary model to use for Supervisor reasoning */
  supervisor_model?: string;
  /** Model to use for Claude executor */
  claude_model?: string;
  /** Model to use for Codex executor */
  codex_model?: string;
  /** Fallback model when primary is unavailable */
  fallback_model?: string;
  /** Whether to auto-downgrade on rate limits */
  auto_downgrade?: boolean;
}

export interface SecurityPolicy {
  /** Shell commands that are always allowed */
  shell_allowlist?: string[];
  /** Shell commands that are always denied */
  shell_denylist?: string[];
  /** Whether sandbox mode is enforced */
  sandbox_enforced?: boolean;
  /** Operations requiring manual approval */
  approval_required_for?: string[];
}

export interface IterationCounters {
  /** Total number of work orders dispatched */
  total_dispatches: number;
  /** Number of debug iterations */
  debug_iterations: number;
  /** Number of consecutive failures with same error */
  consecutive_same_error: number;
  /** Maximum allowed debug iterations before escalation */
  max_debug_iterations: number;
}

export interface VerificationResults {
  /** Whether all must_pass verifications passed */
  all_passed: boolean;
  /** Individual command results */
  command_results: Array<{
    cmd: string;
    exit_code: number;
    passed: boolean;
    stdout?: string;
    stderr?: string;
  }>;
  /** When verification was last run */
  last_run_at?: string;
}

export interface Artifact {
  /** Type of artifact */
  type: 'diff' | 'log' | 'screenshot' | 'report';
  /** Path to the artifact file */
  path: string;
  /** When the artifact was created */
  created_at: string;
  /** Description of the artifact */
  description?: string;
}

export interface RunState {
  /** Unique run identifier (format: run_XXXXXXXXXXXXXXXX) */
  run_id: string;
  /** Current status of the run */
  status: RunStatus;
  /** Original user goal/request */
  user_goal: string;
  /** Formalized specification (acceptance criteria + verification commands) */
  spec?: {
    acceptance_criteria: string[];
    verification_commands: string[];
  };
  /** Queue of work orders to process */
  task_queue: WorkOrder[];
  /** Currently executing work order */
  current_task?: WorkOrder;
  /** Collected work reports */
  reports: WorkReport[];
  /** Artifacts generated during the run */
  artifacts: Artifact[];
  /** Latest verification results */
  verification_results?: VerificationResults;
  /** Iteration counters for loop control */
  iteration_counters: IterationCounters;
  /** Model selection policy */
  model_policy: ModelPolicy;
  /** Security policy */
  security_policy: SecurityPolicy;
  /** Final report (when completed) */
  final_report?: string;
  /** When the run was created */
  created_at: string;
  /** When the run was last updated */
  updated_at: string;
  /** Error message if failed */
  error?: string;
}

// Factory functions
export function createRunId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = 'run_';
  for (let i = 0; i < 16; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function createWorkOrderId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = 'wo_';
  for (let i = 0; i < 16; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function createWorkReportId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = 'wr_';
  for (let i = 0; i < 16; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function createInitialRunState(userGoal: string): RunState {
  const now = new Date().toISOString();
  return {
    run_id: createRunId(),
    status: 'pending',
    user_goal: userGoal,
    task_queue: [],
    reports: [],
    artifacts: [],
    iteration_counters: {
      total_dispatches: 0,
      debug_iterations: 0,
      consecutive_same_error: 0,
      max_debug_iterations: 5,
    },
    model_policy: {
      auto_downgrade: true,
    },
    security_policy: {
      sandbox_enforced: true,
    },
    created_at: now,
    updated_at: now,
  };
}
