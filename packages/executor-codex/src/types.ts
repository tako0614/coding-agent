/**
 * Types for Codex SDK adapter
 */

export interface CodexConfig {
  /** Model to use (default: 'gpt-4.1') */
  model?: string;
  /** Whether to run in sandbox mode */
  sandbox?: boolean;
  /** Writable root directories */
  writableRoots?: string[];
}

export interface CodexExecutionOptions {
  /** Working directory */
  cwd: string;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Environment variables */
  env?: Record<string, string>;
  /** Stream event handler */
  onEvent?: (event: CodexEvent) => void;
  /** Thread ID to resume */
  resumeThreadId?: string;
}

/** Event types from Codex SDK */
export type CodexEvent =
  | CodexTextEvent
  | CodexToolCallEvent
  | CodexToolResultEvent
  | CodexFileChangeEvent
  | CodexCompleteEvent;

export interface CodexTextEvent {
  type: 'text';
  content: string;
}

export interface CodexToolCallEvent {
  type: 'tool_call';
  tool_call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
}

export interface CodexToolResultEvent {
  type: 'tool_result';
  tool_call_id: string;
  output: string;
  is_error?: boolean;
}

export interface CodexFileChangeEvent {
  type: 'file_change';
  path: string;
  action: 'create' | 'modify' | 'delete';
}

export interface CodexCompleteEvent {
  type: 'complete';
  result: string;
  thread_id: string;
}

export interface CodexExecutionResult {
  success: boolean;
  result?: string;
  threadId?: string;
  filesModified: string[];
  commandsRun: Array<{
    command: string;
    exitCode: number;
    output: string;
  }>;
  error?: string;
}
