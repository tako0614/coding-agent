/**
 * Types for Claude Agent SDK adapter
 */

export interface ClaudeConfig {
  /** Model to use (default: 'claude-sonnet-4-20250514') */
  model?: string;
  /** Allowed tools for the agent */
  allowedTools?: string[];
  /** Maximum conversation turns */
  maxTurns?: number;
  /** Permission mode for tool execution */
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions';
  /** System prompt to prepend */
  systemPrompt?: string;
}

export interface ClaudeExecutionOptions {
  /** Working directory */
  cwd: string;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Environment variables */
  env?: Record<string, string>;
  /** Stream message handler */
  onMessage?: (message: ClaudeAgentMessage) => void;
  /** Session ID to resume */
  resumeSessionId?: string;
}

/** Message types from Claude Agent SDK */
export type ClaudeAgentMessage =
  | ClaudeSystemMessage
  | ClaudeAssistantMessage
  | ClaudeToolUseMessage
  | ClaudeToolResultMessage
  | ClaudeResultMessage;

export interface ClaudeSystemMessage {
  type: 'system';
  subtype: 'init' | 'error';
  session_id?: string;
  message?: string;
}

export interface ClaudeAssistantMessage {
  type: 'assistant';
  content: string;
}

export interface ClaudeToolUseMessage {
  type: 'tool_use';
  tool_use_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface ClaudeToolResultMessage {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface ClaudeResultMessage {
  type: 'result';
  result: string;
  session_id: string;
}

export interface ClaudeExecutionResult {
  success: boolean;
  result?: string;
  sessionId?: string;
  filesModified: string[];
  commandsRun: Array<{
    command: string;
    exitCode: number;
    output: string;
  }>;
  error?: string;
}
