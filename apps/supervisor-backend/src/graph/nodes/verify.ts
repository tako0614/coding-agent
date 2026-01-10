/**
 * Verify Node
 * Runs verification commands to check if the work is complete
 */

import { createShellExecutor } from '@supervisor/tool-runtime';
import type { VerificationResults } from '@supervisor/protocol';
import type { SupervisorStateType } from '../state.js';
import { log as eventLog } from '../../services/event-bus.js';

export async function verifyNode(
  state: SupervisorStateType
): Promise<Partial<SupervisorStateType>> {
  console.log('[Verify] Running verification commands...');
  eventLog(state.run_id, 'info', 'supervisor', '✅ Verify: Running verification...', { node: 'verify' });

  if (!state.spec?.verification_commands.length) {
    console.log('[Verify] No verification commands to run');
    return {
      verification_results: {
        all_passed: true,
        command_results: [],
        last_run_at: new Date().toISOString(),
      },
      status: 'verifying',
      updated_at: new Date().toISOString(),
    };
  }

  const shell = createShellExecutor(state.repo_path, {
    allowlist: ['npm', 'npx', 'pnpm', 'yarn', 'node', 'tsc', 'vitest', 'jest', 'eslint', 'prettier'],
    denylist: [],
    argumentPatterns: {},
    maxExecutionTimeMs: 300000,
    maxOutputSizeBytes: 10485760,
  });

  const results: VerificationResults['command_results'] = [];
  let allPassed = true;

  for (const cmd of state.spec.verification_commands) {
    console.log(`[Verify] Running: ${cmd}`);

    const result = await shell.execute(cmd);

    const passed = result.exitCode === 0;
    if (!passed) {
      allPassed = false;
    }

    results.push({
      cmd,
      exit_code: result.exitCode,
      passed,
      stdout: result.stdout.slice(0, 5000),
      stderr: result.stderr.slice(0, 5000),
    });

    console.log(`[Verify] ${cmd}: ${passed ? 'PASSED' : 'FAILED'} (exit code: ${result.exitCode})`);
  }

  console.log(`[Verify] Overall: ${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`);

  return {
    verification_results: {
      all_passed: allPassed,
      command_results: results,
      last_run_at: new Date().toISOString(),
    },
    status: 'verifying',
    updated_at: new Date().toISOString(),
  };
}
