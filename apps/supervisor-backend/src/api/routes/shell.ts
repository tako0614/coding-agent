/**
 * Shell execution API routes
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createShellExecutor, loadPolicyFromConfig } from '@supervisor/tool-runtime';
import fs from 'node:fs/promises';
import path from 'node:path';

const shell = new Hono();

const ExecuteSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeout: z.number().optional(),
});

// Load policy from config file
async function loadPolicy() {
  try {
    const configPath = path.resolve(process.cwd(), '../../configs/policy/default.json');
    const content = await fs.readFile(configPath, 'utf-8');
    return loadPolicyFromConfig(JSON.parse(content));
  } catch {
    // Return default policy if config not found
    return {
      shell: {
        allowlist: ['npm', 'npx', 'pnpm', 'node', 'git', 'ls', 'cat', 'pwd', 'echo'],
        denylist: ['rm -rf /', 'sudo'],
        argumentPatterns: {},
        maxExecutionTimeMs: 300000,
        maxOutputSizeBytes: 10485760,
      },
      filesystem: {
        writeRoots: ['./'],
        forbiddenPaths: [],
        maxFileSizeBytes: 52428800,
      },
    };
  }
}

/**
 * POST /api/shell/execute
 * Execute a shell command
 */
shell.post('/execute', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = ExecuteSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({
        error: {
          message: 'Invalid request body',
          details: parsed.error.errors,
        },
      }, 400);
    }

    const { command, cwd, timeout } = parsed.data;
    const workingDir = cwd || process.cwd();

    const policy = await loadPolicy();
    const executor = createShellExecutor(workingDir, policy.shell);

    // Check if command is allowed
    const policyCheck = executor.checkPolicy(command);
    if (!policyCheck.allowed) {
      return c.json({
        error: {
          message: `Command not allowed: ${policyCheck.reason}`,
          code: 'POLICY_VIOLATION',
        },
      }, 403);
    }

    const result = await executor.execute(command, { timeout });

    return c.json({
      command: result.cmd,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
    });
  } catch (error) {
    console.error('[Shell] Execution error:', error);
    return c.json({
      error: {
        message: error instanceof Error ? error.message : 'Failed to execute command',
      },
    }, 500);
  }
});

/**
 * POST /api/shell/check
 * Check if a command is allowed by policy
 */
shell.post('/check', async (c) => {
  try {
    const body = await c.req.json();
    const { command } = body;

    if (!command || typeof command !== 'string') {
      return c.json({
        error: { message: 'Command is required' },
      }, 400);
    }

    const policy = await loadPolicy();
    const executor = createShellExecutor(process.cwd(), policy.shell);
    const result = executor.checkPolicy(command);

    return c.json({
      command,
      allowed: result.allowed,
      reason: result.reason,
      requiresConfirmation: result.requiresConfirmation,
      confirmationReason: result.confirmationReason,
    });
  } catch (error) {
    return c.json({
      error: {
        message: error instanceof Error ? error.message : 'Failed to check command',
      },
    }, 500);
  }
});

export { shell };
