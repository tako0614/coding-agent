/**
 * Claude Agent SDK Adapter
 * Uses Claude Agent SDK to execute WorkOrders and produce WorkReports
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  WorkOrder,
  WorkReport,
  CommandResult,
} from '@supervisor/protocol';
import { createWorkReportId } from '@supervisor/protocol';
import type {
  ClaudeConfig,
  ClaudeExecutionOptions,
  ClaudeExecutionResult,
  ClaudeAgentMessage,
} from './types.js';

/** Helper to safely get property from unknown object */
function getProp<T>(obj: unknown, key: string): T | undefined {
  if (obj && typeof obj === 'object' && key in obj) {
    return (obj as Record<string, unknown>)[key] as T;
  }
  return undefined;
}

export class ClaudeAdapter {
  private config: Required<ClaudeConfig>;

  constructor(config: ClaudeConfig = {}) {
    this.config = {
      model: config.model ?? 'claude-sonnet-4-20250514',
      allowedTools: config.allowedTools ?? ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
      maxTurns: config.maxTurns ?? 50,
      permissionMode: config.permissionMode ?? 'acceptEdits',
      systemPrompt: config.systemPrompt ?? '',
    };
  }

  /**
   * Build the prompt from a WorkOrder
   */
  private buildPrompt(order: WorkOrder): string {
    const lines: string[] = [];

    // Task type indicator
    lines.push(`Task type: ${order.task_kind.toUpperCase()}`);
    lines.push('');

    // Objective
    lines.push('## Objective');
    lines.push(order.objective);
    lines.push('');

    // Background (if present)
    if (order.background) {
      lines.push('## Background');
      lines.push(order.background);
      lines.push('');
    }

    // Acceptance Criteria
    lines.push('## Acceptance Criteria');
    for (const criterion of order.acceptance_criteria) {
      lines.push(`- ${criterion}`);
    }
    lines.push('');

    // Constraints
    if (order.constraints) {
      lines.push('## Constraints');
      if (order.constraints.allowed_paths?.length) {
        lines.push(`- Only modify files in: ${order.constraints.allowed_paths.join(', ')}`);
      }
      if (order.constraints.forbidden_paths?.length) {
        lines.push(`- Do NOT modify: ${order.constraints.forbidden_paths.join(', ')}`);
      }
      if (order.constraints.dependency_policy === 'deny') {
        lines.push('- Do NOT add new dependencies');
      } else if (order.constraints.dependency_policy === 'existing_only') {
        lines.push('- Only use existing dependencies');
      }
      lines.push('');
    }

    // Verification commands
    lines.push('## Verification');
    lines.push('Before reporting completion, run these commands:');
    for (const cmd of order.verification.commands) {
      lines.push(`- \`${cmd.cmd}\`${cmd.must_pass ? ' (MUST PASS)' : ''}`);
    }
    lines.push('');

    // Final instructions
    lines.push('## Important');
    lines.push('- Complete the objective thoroughly');
    lines.push('- Ensure all acceptance criteria are met');
    lines.push('- Run verification commands before finishing');
    lines.push('- If you encounter issues, report them clearly');

    return lines.join('\n');
  }

  /**
   * Execute a WorkOrder using Claude Agent SDK
   */
  async execute(order: WorkOrder, options: ClaudeExecutionOptions): Promise<WorkReport> {
    const startTime = new Date();

    const prompt = this.buildPrompt(order);
    const filesModified: string[] = [];
    const commandsRun: Array<{ command: string; exitCode: number; output: string }> = [];
    let sessionId: string | undefined;
    let finalResult: string | undefined;
    let hasError = false;
    let errorMessage: string | undefined;

    try {
      // Build SDK options
      const sdkOptions: Record<string, unknown> = {
        allowedTools: this.config.allowedTools,
        maxTurns: this.config.maxTurns,
        permissionMode: this.config.permissionMode,
        cwd: options.cwd,
        // Disable session persistence to avoid filesystem issues
        persistSession: false,
        // Capture stderr for debugging
        stderr: (data: string) => {
          console.error('[ClaudeAdapter] STDERR:', data);
        },
      };

      // Resume session if provided
      if (options.resumeSessionId) {
        sdkOptions['resume'] = options.resumeSessionId;
      }

      // System prompt if provided
      if (this.config.systemPrompt) {
        sdkOptions['systemPrompt'] = this.config.systemPrompt;
      }

      // Set environment variables
      if (options.env) {
        for (const [key, value] of Object.entries(options.env)) {
          process.env[key] = value;
        }
      }

      // Execute using the SDK's async generator
      console.log('[ClaudeAdapter] Starting SDK query...');
      console.log('[ClaudeAdapter] Options:', JSON.stringify(sdkOptions, null, 2));

      for await (const message of query({
        prompt,
        options: sdkOptions,
      })) {
        console.log('[ClaudeAdapter] Message:', JSON.stringify(message, null, 2).slice(0, 500));
        // Call message handler if provided
        if (options.onMessage) {
          options.onMessage(message as ClaudeAgentMessage);
        }

        // Process message types
        const msgType = getProp<string>(message, 'type');
        const msgSubtype = getProp<string>(message, 'subtype');

        // Capture session ID from init message
        if (msgType === 'system' && msgSubtype === 'init') {
          const sid = getProp<string>(message, 'session_id');
          if (sid) sessionId = sid;
        }

        // Track file modifications from Edit/Write tool uses
        if (msgType === 'tool_use') {
          const toolName = getProp<string>(message, 'tool_name');
          const toolInput = getProp<Record<string, unknown>>(message, 'tool_input');

          if ((toolName === 'Edit' || toolName === 'Write') && toolInput) {
            const filePath = getProp<string>(toolInput, 'file_path');
            if (filePath && !filesModified.includes(filePath)) {
              filesModified.push(filePath);
            }
          }

          // Track Bash commands
          if (toolName === 'Bash' && toolInput) {
            const cmd = getProp<string>(toolInput, 'command');
            if (cmd) {
              commandsRun.push({
                command: cmd,
                exitCode: 0, // Will be updated from tool_result
                output: '',
              });
            }
          }
        }

        // Track tool results for exit codes
        if (msgType === 'tool_result') {
          const isError = getProp<boolean>(message, 'is_error');
          const content = getProp<string>(message, 'content');
          const lastCmd = commandsRun[commandsRun.length - 1];
          if (lastCmd) {
            if (isError) {
              lastCmd.exitCode = 1;
            }
            if (content) {
              lastCmd.output = content;
            }
          }
        }

        // Capture final result
        if (msgType === 'result' || getProp<string>(message, 'result')) {
          finalResult = getProp<string>(message, 'result');
          const sid = getProp<string>(message, 'session_id');
          if (sid) sessionId = sid;
        }

        // Handle errors
        if (msgType === 'system' && msgSubtype === 'error') {
          hasError = true;
          errorMessage = getProp<string>(message, 'message');
        }
      }

      const endTime = new Date();

      // Build command results
      const commandResults: CommandResult[] = commandsRun.map((cmd) => ({
        cmd: cmd.command,
        exit_code: cmd.exitCode,
        stdout: cmd.output,
      }));

      // Determine status
      const status: WorkReport['status'] = hasError ? 'failed' : 'done';

      return {
        report_id: createWorkReportId(),
        order_id: order.order_id,
        run_id: order.run_id,
        executor: 'claude',
        status,
        summary: hasError
          ? `Failed: ${errorMessage}`
          : `Completed: ${filesModified.length} files modified, ${commandsRun.length} commands run`,
        changes: {
          files_modified: filesModified,
        },
        commands_run: commandResults,
        verification: {
          passed: !hasError,
          details: hasError ? errorMessage : 'Executor reports success',
        },
        error: hasError
          ? {
              message: errorMessage ?? 'Unknown error',
            }
          : undefined,
        metadata: {
          started_at: startTime.toISOString(),
          completed_at: endTime.toISOString(),
          model: this.config.model,
        },
      };
    } catch (error) {
      const endTime = new Date();
      const errMsg = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;

      console.error('[ClaudeAdapter] Execution failed:', errMsg);
      console.error('[ClaudeAdapter] Stack:', stack);

      return {
        report_id: createWorkReportId(),
        order_id: order.order_id,
        run_id: order.run_id,
        executor: 'claude',
        status: 'failed',
        summary: `Execution failed: ${errMsg}`,
        commands_run: [],
        verification: {
          passed: false,
          details: errMsg,
        },
        error: {
          message: errMsg,
          stack: error instanceof Error ? error.stack : undefined,
        },
        metadata: {
          started_at: startTime.toISOString(),
          completed_at: endTime.toISOString(),
          model: this.config.model,
        },
      };
    }
  }

  /**
   * Execute with streaming events
   */
  async *executeStreaming(
    order: WorkOrder,
    options: ClaudeExecutionOptions
  ): AsyncGenerator<ClaudeAgentMessage, ClaudeExecutionResult> {
    const prompt = this.buildPrompt(order);
    const filesModified: string[] = [];
    const commandsRun: Array<{ command: string; exitCode: number; output: string }> = [];
    let sessionId: string | undefined;
    let finalResult: string | undefined;
    let hasError = false;
    let errorMessage: string | undefined;

    const sdkOptions: Record<string, unknown> = {
      allowedTools: this.config.allowedTools,
      maxTurns: this.config.maxTurns,
      permissionMode: this.config.permissionMode,
      cwd: options.cwd,
      persistSession: false,
      stderr: (data: string) => {
        console.error('[ClaudeAdapter] STDERR:', data);
      },
    };

    if (options.resumeSessionId) {
      sdkOptions['resume'] = options.resumeSessionId;
    }

    try {
      for await (const message of query({ prompt, options: sdkOptions })) {
        const msgType = getProp<string>(message, 'type');
        const msgSubtype = getProp<string>(message, 'subtype');

        // Capture session ID from init message
        if (msgType === 'system' && msgSubtype === 'init') {
          const sid = getProp<string>(message, 'session_id');
          if (sid) sessionId = sid;
        }

        if (msgType === 'tool_use') {
          const toolName = getProp<string>(message, 'tool_name');
          const toolInput = getProp<Record<string, unknown>>(message, 'tool_input');

          if ((toolName === 'Edit' || toolName === 'Write') && toolInput) {
            const filePath = getProp<string>(toolInput, 'file_path');
            if (filePath && !filesModified.includes(filePath)) {
              filesModified.push(filePath);
            }
          }

          if (toolName === 'Bash' && toolInput) {
            const cmd = getProp<string>(toolInput, 'command');
            if (cmd) {
              commandsRun.push({
                command: cmd,
                exitCode: 0,
                output: '',
              });
            }
          }
        }

        if (msgType === 'result' || getProp<string>(message, 'result')) {
          finalResult = getProp<string>(message, 'result');
          const sid = getProp<string>(message, 'session_id');
          if (sid) sessionId = sid;
        }

        if (msgType === 'system' && msgSubtype === 'error') {
          hasError = true;
          errorMessage = getProp<string>(message, 'message');
        }

        yield message as ClaudeAgentMessage;
      }

      return {
        success: !hasError,
        result: finalResult,
        sessionId,
        filesModified,
        commandsRun,
        error: errorMessage,
      };
    } catch (error) {
      return {
        success: false,
        filesModified,
        commandsRun,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check if Claude Agent SDK is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      // SDK is available if we can import it
      return typeof query === 'function';
    } catch {
      return false;
    }
  }

  /**
   * Get SDK version
   */
  async getVersion(): Promise<string | null> {
    try {
      // Return package version
      return '0.1.76'; // From installed package
    } catch {
      return null;
    }
  }
}

/**
 * Create a Claude adapter instance
 */
export function createClaudeAdapter(config?: ClaudeConfig): ClaudeAdapter {
  return new ClaudeAdapter(config);
}
