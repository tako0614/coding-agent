/**
 * Spec Agent exports
 */

export { SpecAgent, specAgentStore, type SpecAgentConfig, type ChatResponse } from './spec-agent.js';
export { SPEC_TOOLS, executeTool, type ToolDefinition, type ToolResult } from './spec-tools.js';
export {
  getConversation,
  saveConversation,
  addMessage,
  addMessageLocked,
  deleteConversation,
  toAnthropicMessages,
  type Conversation,
  type ConversationMessage,
} from './spec-store.js';

// Structured spec schema and service
export {
  type StructuredSpec,
  type Requirement,
  type Component,
  type APIEndpoint,
  StructuredSpecSchema,
  RequirementSchema,
  createEmptySpec,
  validateSpec,
  specToMarkdown,
} from './spec-schema.js';

export {
  saveStructuredSpec,
  getStructuredSpec,
  getSpecMarkdown,
  deleteStructuredSpec,
  linkImplementationToSpec,
  getSpecForImplementation,
  getImplementationsForSpec,
  specToImplementationContext,
} from './spec-service.js';

// Conversation threading (branching support)
export {
  createThread,
  getThread,
  getThreadsForRun,
  getActiveThread,
  getOrCreateActiveThread,
  switchThread,
  branchFromMessage,
  addMessageToThread,
  getThreadMessages,
  deleteThread,
  getConversationTree,
  type ConversationThread,
  type ThreadMessage,
} from './conversation-thread.js';
