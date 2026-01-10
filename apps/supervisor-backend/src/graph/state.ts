/**
 * LangGraph State definition for Supervisor
 */

import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';
import type {
  RunState,
  RunStatus,
  WorkOrder,
  WorkReport,
  Artifact,
  VerificationResults,
  ModelPolicy,
  SecurityPolicy,
  IterationCounters,
} from '@supervisor/protocol';

/**
 * Supervisor Graph State
 */
export const SupervisorState = Annotation.Root({
  // Core identifiers
  run_id: Annotation<string>(),
  status: Annotation<RunStatus>(),

  // User input
  user_goal: Annotation<string>(),

  // Specification
  spec: Annotation<{
    acceptance_criteria: string[];
    verification_commands: string[];
  } | undefined>(),

  // Task management
  task_queue: Annotation<WorkOrder[]>({
    reducer: (current, update) => {
      // Support both replace and append
      if (Array.isArray(update) && update.length > 0 && update[0] === null) {
        // Clear signal
        return [];
      }
      return update;
    },
    default: () => [],
  }),
  current_task: Annotation<WorkOrder | undefined>(),

  // Results
  reports: Annotation<WorkReport[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),
  artifacts: Annotation<Artifact[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),
  verification_results: Annotation<VerificationResults | undefined>(),

  // Loop control
  iteration_counters: Annotation<IterationCounters>({
    reducer: (current, update) => ({ ...current, ...update }),
    default: () => ({
      total_dispatches: 0,
      debug_iterations: 0,
      consecutive_same_error: 0,
      max_debug_iterations: 5,
    }),
  }),

  // Policies
  model_policy: Annotation<ModelPolicy>({
    default: () => ({ auto_downgrade: true }),
  }),
  security_policy: Annotation<SecurityPolicy>({
    default: () => ({ sandbox_enforced: true }),
  }),

  // Repository context
  repo_path: Annotation<string>(),
  base_commit: Annotation<string | undefined>(),

  // Final output
  final_report: Annotation<string | undefined>(),
  error: Annotation<string | undefined>(),

  // Conversation messages (for LLM interactions)
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),

  // Timestamps
  created_at: Annotation<string>(),
  updated_at: Annotation<string>(),
});

export type SupervisorStateType = typeof SupervisorState.State;

/**
 * Create initial state from user goal
 */
export function createInitialState(
  runId: string,
  userGoal: string,
  repoPath: string
): Partial<SupervisorStateType> {
  const now = new Date().toISOString();
  return {
    run_id: runId,
    status: 'pending',
    user_goal: userGoal,
    repo_path: repoPath,
    task_queue: [],
    reports: [],
    artifacts: [],
    iteration_counters: {
      total_dispatches: 0,
      debug_iterations: 0,
      consecutive_same_error: 0,
      max_debug_iterations: 5,
    },
    model_policy: { auto_downgrade: true },
    security_policy: { sandbox_enforced: true },
    created_at: now,
    updated_at: now,
  };
}
