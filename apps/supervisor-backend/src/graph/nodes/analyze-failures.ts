/**
 * AnalyzeFailures Node
 * Analyzes verification failures and creates debug WorkOrders
 */

import type { WorkOrder } from '@supervisor/protocol';
import { createWorkOrderId } from '@supervisor/protocol';
import type { SupervisorStateType } from '../state.js';

export async function analyzeFailuresNode(
  state: SupervisorStateType
): Promise<Partial<SupervisorStateType>> {
  console.log('[AnalyzeFailures] Analyzing verification failures...');

  if (!state.verification_results || state.verification_results.all_passed) {
    console.log('[AnalyzeFailures] No failures to analyze');
    return {};
  }

  // Get failed commands
  const failedCommands = state.verification_results.command_results.filter(r => !r.passed);

  if (failedCommands.length === 0) {
    return {};
  }

  // Build background context for debug task
  const backgroundLines: string[] = [
    '## Previous Attempt Failed',
    '',
    'The following verification commands failed:',
    '',
  ];

  for (const failed of failedCommands) {
    backgroundLines.push(`### Command: \`${failed.cmd}\``);
    backgroundLines.push(`Exit code: ${failed.exit_code}`);
    if (failed.stderr) {
      backgroundLines.push('');
      backgroundLines.push('**stderr (last 50 lines):**');
      backgroundLines.push('```');
      const stderrLines = failed.stderr.split('\n');
      backgroundLines.push(stderrLines.slice(-50).join('\n'));
      backgroundLines.push('```');
    }
    if (failed.stdout) {
      backgroundLines.push('');
      backgroundLines.push('**stdout (last 20 lines):**');
      backgroundLines.push('```');
      const stdoutLines = failed.stdout.split('\n');
      backgroundLines.push(stdoutLines.slice(-20).join('\n'));
      backgroundLines.push('```');
    }
    backgroundLines.push('');
  }

  // Get latest report for additional context
  const latestReport = state.reports[state.reports.length - 1];
  if (latestReport?.changes?.files_modified?.length) {
    backgroundLines.push('## Files Modified in Previous Attempt');
    for (const file of latestReport.changes.files_modified) {
      backgroundLines.push(`- ${file}`);
    }
  }

  // Create debug WorkOrder
  const debugOrder: WorkOrder = {
    order_id: createWorkOrderId(),
    run_id: state.run_id,
    parent_order_id: latestReport?.order_id,
    task_kind: 'debug',
    repo: {
      path: state.repo_path,
      base_commit: state.base_commit,
    },
    objective: 'Fix the errors causing verification to fail',
    background: backgroundLines.join('\n'),
    acceptance_criteria: [
      'All verification commands pass',
      'The original acceptance criteria are still met',
      'No new errors are introduced',
    ],
    verification: {
      commands: (state.spec?.verification_commands ?? []).map(cmd => ({
        cmd,
        must_pass: true,
        timeout_ms: 300000,
      })),
    },
    tooling: {
      sandbox: state.security_policy.sandbox_enforced ?? true,
      approval_required: false,
      write_roots: [state.repo_path],
    },
    metadata: {
      created_at: new Date().toISOString(),
      priority: 8, // Higher priority for debug tasks
      retry_count: state.iteration_counters.debug_iterations,
      max_retries: state.iteration_counters.max_debug_iterations,
    },
  };

  // Update iteration counters
  const newCounters = {
    ...state.iteration_counters,
    debug_iterations: state.iteration_counters.debug_iterations + 1,
  };

  console.log(`[AnalyzeFailures] Created debug WorkOrder (iteration ${newCounters.debug_iterations})`);

  return {
    task_queue: [debugOrder],
    iteration_counters: newCounters,
    status: 'debugging',
    updated_at: new Date().toISOString(),
  };
}
