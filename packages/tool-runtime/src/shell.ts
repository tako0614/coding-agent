/**
 * Shell command executor with policy enforcement
 */

import { execaCommand, type Options as ExecaOptions } from 'execa';
import type { CommandResult, ShellPolicy, PolicyCheckResult } from './types.js';
import { checkShellPolicy } from './policy-checker.js';

export interface ShellExecutorOptions {
  policy: ShellPolicy;
  cwd: string;
  env?: Record<string, string>;
  onConfirmationRequired?: (command: string, reason: string) => Promise<boolean>;
}

export interface ExecuteOptions {
  timeout?: number;
  skipPolicyCheck?: boolean;
}

export class ShellExecutor {
  private policy: ShellPolicy;
  private cwd: string;
  private env: Record<string, string>;
  private onConfirmationRequired?: (command: string, reason: string) => Promise<boolean>;

  constructor(options: ShellExecutorOptions) {
    this.policy = options.policy;
    this.cwd = options.cwd;
    this.env = options.env ?? {};
    this.onConfirmationRequired = options.onConfirmationRequired;
  }

  /**
   * Check if a command is allowed by policy
   */
  checkPolicy(command: string): PolicyCheckResult {
    return checkShellPolicy(command, this.policy);
  }

  /**
   * Execute a shell command
   */
  async execute(command: string, options: ExecuteOptions = {}): Promise<CommandResult> {
    const startTime = Date.now();
    const timeout = options.timeout ?? this.policy.maxExecutionTimeMs;

    // Check policy unless explicitly skipped
    if (!options.skipPolicyCheck) {
      const policyCheck = this.checkPolicy(command);

      if (!policyCheck.allowed) {
        return {
          cmd: command,
          exitCode: -1,
          stdout: '',
          stderr: `Policy violation: ${policyCheck.reason}`,
          durationMs: Date.now() - startTime,
          killed: false,
          timedOut: false,
        };
      }

      // Handle confirmation requirement
      if (policyCheck.requiresConfirmation) {
        if (!this.onConfirmationRequired) {
          return {
            cmd: command,
            exitCode: -1,
            stdout: '',
            stderr: `Command requires confirmation but no confirmation handler provided: ${policyCheck.confirmationReason}`,
            durationMs: Date.now() - startTime,
            killed: false,
            timedOut: false,
          };
        }

        const confirmed = await this.onConfirmationRequired(
          command,
          policyCheck.confirmationReason ?? 'Command requires confirmation'
        );

        if (!confirmed) {
          return {
            cmd: command,
            exitCode: -1,
            stdout: '',
            stderr: 'Command execution cancelled by user',
            durationMs: Date.now() - startTime,
            killed: false,
            timedOut: false,
          };
        }
      }
    }

    const execaOptions: ExecaOptions = {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      timeout,
      reject: false,
      stripFinalNewline: true,
    };

    try {
      const result = await execaCommand(command, execaOptions);

      // Truncate output if too large
      let stdout = String(result.stdout ?? '');
      let stderr = String(result.stderr ?? '');

      if (stdout.length > this.policy.maxOutputSizeBytes) {
        stdout = stdout.slice(0, this.policy.maxOutputSizeBytes) +
          `\n... (truncated, ${stdout.length} bytes total)`;
      }

      if (stderr.length > this.policy.maxOutputSizeBytes) {
        stderr = stderr.slice(0, this.policy.maxOutputSizeBytes) +
          `\n... (truncated, ${stderr.length} bytes total)`;
      }

      return {
        cmd: command,
        exitCode: result.exitCode ?? 0,
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
        killed: result.isTerminated ?? false,
        timedOut: result.timedOut ?? false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        cmd: command,
        exitCode: -1,
        stdout: '',
        stderr: `Execution error: ${errorMessage}`,
        durationMs: Date.now() - startTime,
        killed: false,
        timedOut: false,
      };
    }
  }

  /**
   * Execute multiple commands sequentially
   */
  async executeSequence(
    commands: string[],
    options: ExecuteOptions & { stopOnError?: boolean } = {}
  ): Promise<CommandResult[]> {
    const results: CommandResult[] = [];
    const { stopOnError = true, ...execOptions } = options;

    for (const command of commands) {
      const result = await this.execute(command, execOptions);
      results.push(result);

      if (stopOnError && result.exitCode !== 0) {
        break;
      }
    }

    return results;
  }

  /**
   * Update the working directory
   */
  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  /**
   * Get the current working directory
   */
  getCwd(): string {
    return this.cwd;
  }
}

/**
 * Create a shell executor with default policy
 */
export function createShellExecutor(
  cwd: string,
  policy?: Partial<ShellPolicy>
): ShellExecutor {
  const defaultPolicy: ShellPolicy = {
    allowlist: ['npm', 'npx', 'pnpm', 'node', 'tsc', 'git', 'ls', 'cat', 'echo', 'pwd'],
    denylist: ['rm -rf /', 'sudo', 'su'],
    argumentPatterns: {},
    maxExecutionTimeMs: 300000,
    maxOutputSizeBytes: 10485760,
  };

  return new ShellExecutor({
    policy: { ...defaultPolicy, ...policy },
    cwd,
  });
}
