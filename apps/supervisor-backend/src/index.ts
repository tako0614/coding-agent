/**
 * @supervisor/backend
 * Supervisor Backend - LangGraph orchestration + OpenAI-compatible API
 */

// Graph (Parallel execution)
export {
  createParallelSupervisorGraph,
  runParallelSupervisor,
  ParallelSupervisorState,
  type ParallelSupervisorStateType,
  createInitialParallelState,
} from './graph/parallel-graph.js';

// API types
export type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatMessage,
  CreateRunRequest,
  RunResponse,
  RunListResponse,
} from './api/types.js';

// Run store
export { runStore } from './api/run-store.js';
