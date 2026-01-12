/**
 * @supervisor/backend
 * Supervisor Backend - Supervisor Agent + OpenAI-compatible API
 */

// Graph (Supervisor Agent)
export {
  createSupervisorGraph,
  runSupervisor,
  createSimplifiedSupervisorGraph,
  runSimplifiedSupervisor,
  SimplifiedSupervisorState,
  type SimplifiedSupervisorStateType,
  type RunSimplifiedSupervisorOptions,
  type SimplifiedRunStatus,
} from './graph/index.js';

// Supervisor Agent
export {
  SupervisorAgent,
  createSupervisorAgent,
  SUPERVISOR_TOOLS,
  ToolExecutor,
} from './supervisor/index.js';

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
