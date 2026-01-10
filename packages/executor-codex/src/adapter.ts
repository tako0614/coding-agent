/**
 * Codex SDK Adapter
 * Uses OpenAI Codex SDK to execute WorkOrders and produce WorkReports
 */

import { Codex, type ThreadOptions } from '@openai/codex-sdk';
import type {
  WorkOrder,
  WorkReport,
} from '@supervisor/protocol';
import { createWorkReportId } from '@supervisor/protocol';
import type {
  CodexConfig,
  CodexExecutionOptions,
  CodexExecutionResult,
  CodexEvent,
} from './types.js';

/** Helper to safely get property from unknown object */
function getProp<T>(obj: unknown, key: string): T | undefined {
  if (obj && typeof obj === 'object' && key in obj) {
    return (obj as Record<string, unknown>)[key] as T;
  }
  return undefined;
}

export class CodexAdapter {
  private config: Required<CodexConfig>;
  private codex: Codex;

  constructor(config: CodexConfig = {}) {
    this.config = {
      model: config.model ?? 'gpt-4.1',
      sandbox: config.sandbox ?? true,
      writableRoots: config.writableRoots ?? [],
    };
    this.codex = new Codex();
  }

  /**
   * Build the prompt from a WorkOrder
   */
  private buildPrompt(order: WorkOrder): string {
    const lines: string[] = [];

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
        lines.push(`- Allowed paths: ${order.constraints.allowed_paths.join(', ')}`);
      }
      if (order.constraints.forbidden_paths?.length) {
        lines.push(`- Forbidden paths: ${order.constraints.forbidden_paths.join(', ')}`);
      }
      if (order.constraints.dependency_policy) {
        lines.push(`- Dependency policy: ${order.constraints.dependency_policy}`);
      }
      lines.push('');
    }

    // Verification commands (to inform the executor what will be checked)
    lines.push('## Verification');
    lines.push('The following commands will be used to verify the work:');
    for (const cmd of order.verification.commands) {
      lines.push(`- \`${cmd.cmd}\`${cmd.must_pass ? ' (must pass)' : ''}`);
    }
    lines.push('');

    // Instructions
    lines.push('## Instructions');
    lines.push('1. Complete the objective as described');
    lines.push('2. Ensure all acceptance criteria are met');
    lines.push('3. Respect the constraints');
    lines.push('4. Run the verification commands before finishing');
    lines.push('5. Report any issues or questions');

    return lines.join('\n');
  }

  /**
   * Execute a WorkOrder using Codex SDK
   */
  async execute(order: WorkOrder, options: CodexExecutionOptions): Promise<WorkReport> {
    const startTime = new Date();

    const prompt = this.buildPrompt(order);
    const filesModified: string[] = [];
    let threadId: string | undefined;
    let finalResult: string | undefined;
    let hasError = false;
    let errorMessage: string | undefined;

    try {
      // Set environment variables
      if (options.env) {
        for (const [key, value] of Object.entries(options.env)) {
          process.env[key] = value;
        }
      }

      // Set working directory
      if (options.cwd) {
        process.chdir(options.cwd);
      }

      // Build thread options
      const threadOptions: ThreadOptions = {
        skipGitRepoCheck: true,
        workingDirectory: options.cwd,
        sandboxMode: this.config.sandbox ? 'workspace-write' : 'danger-full-access',
        approvalPolicy: 'never',
      };

      // Start or resume thread
      let thread;
      if (options.resumeThreadId) {
        thread = this.codex.resumeThread(options.resumeThreadId, threadOptions);
      } else {
        thread = this.codex.startThread(threadOptions);
      }

      // Get thread ID
      threadId = thread.id ?? undefined;

      // Execute using run() method (non-streaming)
      const result = await thread.run(prompt);

      // Extract result
      finalResult = getProp<string>(result, 'result') ?? '';

      // Notify event handler if provided
      if (options.onEvent) {
        const completeEvent: CodexEvent = {
          type: 'complete',
          result: finalResult,
          thread_id: threadId ?? '',
        };
        options.onEvent(completeEvent);
      }

      const endTime = new Date();

      // Determine status based on result
      const status: WorkReport['status'] = hasError ? 'failed' : 'done';

      return {
        report_id: createWorkReportId(),
        order_id: order.order_id,
        run_id: order.run_id,
        executor: 'codex',
        status,
        summary: hasError
          ? `Failed: ${errorMessage}`
          : `Completed successfully`,
        changes: {
          files_modified: filesModified,
        },
        commands_run: [],
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

      return {
        report_id: createWorkReportId(),
        order_id: order.order_id,
        run_id: order.run_id,
        executor: 'codex',
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
   * Execute with streaming events (placeholder - returns non-streaming result)
   */
  async *executeStreaming(
    order: WorkOrder,
    options: CodexExecutionOptions
  ): AsyncGenerator<CodexEvent, CodexExecutionResult> {
    const prompt = this.buildPrompt(order);
    const filesModified: string[] = [];
    let threadId: string | undefined;
    let finalResult: string | undefined;
    let hasError = false;
    let errorMessage: string | undefined;

    try {
      if (options.cwd) {
        process.chdir(options.cwd);
      }

      // Build thread options
      const threadOptions: ThreadOptions = {
        skipGitRepoCheck: true,
        workingDirectory: options.cwd,
        sandboxMode: this.config.sandbox ? 'workspace-write' : 'danger-full-access',
        approvalPolicy: 'never',
      };

      let thread;
      if (options.resumeThreadId) {
        thread = this.codex.resumeThread(options.resumeThreadId, threadOptions);
      } else {
        thread = this.codex.startThread(threadOptions);
      }

      threadId = thread.id ?? undefined;

      // Execute using run() - non-streaming for now
      const result = await thread.run(prompt);
      finalResult = getProp<string>(result, 'result') ?? '';

      // Yield a complete event
      const completeEvent: CodexEvent = {
        type: 'complete',
        result: finalResult,
        thread_id: threadId ?? '',
      };
      yield completeEvent;

      return {
        success: !hasError,
        result: finalResult,
        threadId,
        filesModified,
        commandsRun: [],
        error: errorMessage,
      };
    } catch (error) {
      return {
        success: false,
        filesModified,
        commandsRun: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Execute simple query without WorkOrder
   */
  async query(prompt: string, options?: { cwd?: string; threadId?: string }): Promise<string> {
    if (options?.cwd) {
      process.chdir(options.cwd);
    }

    // Build thread options
    const threadOptions: ThreadOptions = {
      skipGitRepoCheck: true,
      workingDirectory: options?.cwd,
      sandboxMode: this.config.sandbox ? 'workspace-write' : 'danger-full-access',
      approvalPolicy: 'never',
    };

    let thread;
    if (options?.threadId) {
      thread = this.codex.resumeThread(options.threadId, threadOptions);
    } else {
      thread = this.codex.startThread(threadOptions);
    }

    const result = await thread.run(prompt);
    return getProp<string>(result, 'result') ?? '';
  }

  /**
   * Check if Codex SDK is available and authenticated
   */
  async isAvailable(): Promise<boolean> {
    try {
      // Check if SDK instance exists
      if (!this.codex) {
        console.log('[CodexAdapter] SDK instance not created');
        return false;
      }

      // Try to start a thread to verify authentication
      console.log('[CodexAdapter] Checking availability by starting thread...');
      const threadOptions: ThreadOptions = {
        skipGitRepoCheck: true,
        approvalPolicy: 'never',
      };
      const thread = this.codex.startThread(threadOptions);
      if (thread) {
        console.log('[CodexAdapter] Thread started successfully, SDK is available');
        return true;
      }
      console.log('[CodexAdapter] Failed to start thread');
      return false;
    } catch (error) {
      console.error('[CodexAdapter] Availability check failed:', error);
      return false;
    }
  }

  /**
   * Get SDK version
   */
  async getVersion(): Promise<string | null> {
    try {
      return '0.77.0'; // From package.json
    } catch {
      return null;
    }
  }
}

/**
 * Create a Codex adapter instance
 */
export function createCodexAdapter(config?: CodexConfig): CodexAdapter {
  return new CodexAdapter(config);
}
