/**
 * @supervisor/executor-claude
 * Claude Agent SDK Adapter for Supervisor Agent
 */

export {
  ClaudeAdapter,
  createClaudeAdapter,
} from './adapter.js';

export type {
  ClaudeConfig,
  ClaudeExecutionOptions,
  ClaudeExecutionResult,
  ClaudeAgentMessage,
} from './types.js';
