/**
 * LangGraph State definition for Parallel Supervisor
 * Extends the base state with DAG and worker pool support
 *
 * Worker scaling is dynamic based on DAG complexity - no manual config needed.
 */

import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import {
  type BaseMessage,
  HumanMessage,
  AIMessage,
  SystemMessage,
} from '@langchain/core/messages';
import type {
  RunStatus,
  WorkReport,
  Artifact,
  ModelPolicy,
  SecurityPolicy,
  DAG,
  DAGProgress,
  WorkerPoolStatus,
} from '@supervisor/protocol';

export type ParallelRunStatus =
  | 'pending'
  | 'planning'
  | 'building_dag'
  | 'executing'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Parallel Supervisor Graph State
 */
export const ParallelSupervisorState = Annotation.Root({
  // Core identifiers
  run_id: Annotation<string>(),
  status: Annotation<ParallelRunStatus>(),

  // User input
  user_goal: Annotation<string>(),

  // Project reference (for spec editing by supervisor)
  project_id: Annotation<string | undefined>(),

  // Specification
  spec: Annotation<{
    acceptance_criteria: string[];
    verification_commands: string[];
  } | undefined>(),

  // DAG management
  dag: Annotation<DAG | undefined>(),
  dag_progress: Annotation<DAGProgress | undefined>(),

  // Worker pool status (workers are dynamically scaled based on DAG)
  worker_pool_status: Annotation<WorkerPoolStatus | undefined>(),

  // Results
  reports: Annotation<WorkReport[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),
  artifacts: Annotation<Artifact[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
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
  repo_context: Annotation<string | undefined>(), // Content from AGENTS.md, README.md, etc.
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

export type ParallelSupervisorStateType = typeof ParallelSupervisorState.State;

/**
 * OpenAI-compatible message format
 */
export interface ChatMessageInput {
  role: 'system' | 'user' | 'assistant';
  content: string;
  name?: string;
}

/**
 * Convert OpenAI-format messages to LangChain BaseMessage array
 */
export function convertToLangChainMessages(
  messages: ChatMessageInput[]
): BaseMessage[] {
  return messages.map((msg) => {
    switch (msg.role) {
      case 'system':
        return new SystemMessage(msg.content);
      case 'user':
        return new HumanMessage(msg.content);
      case 'assistant':
        return new AIMessage(msg.content);
      default:
        return new HumanMessage(msg.content);
    }
  });
}

/**
 * Create initial parallel state from user goal
 * Worker pool is dynamically scaled based on DAG complexity
 */
export function createInitialParallelState(
  runId: string,
  userGoal: string,
  repoPath: string,
  projectId?: string,
  chatHistory?: ChatMessageInput[]
): Partial<ParallelSupervisorStateType> {
  const now = new Date().toISOString();

  // Convert chat history to LangChain messages if provided
  const messages = chatHistory
    ? convertToLangChainMessages(chatHistory)
    : [];

  return {
    run_id: runId,
    status: 'pending',
    user_goal: userGoal,
    repo_path: repoPath,
    project_id: projectId,
    messages,
    reports: [],
    artifacts: [],
    model_policy: { auto_downgrade: true },
    security_policy: { sandbox_enforced: true },
    created_at: now,
    updated_at: now,
  };
}
