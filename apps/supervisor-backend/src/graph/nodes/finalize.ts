/**
 * Finalize Node
 * Generates the final report and cleanup
 */

import type { SupervisorStateType } from '../state.js';

export async function finalizeNode(
  state: SupervisorStateType
): Promise<Partial<SupervisorStateType>> {
  console.log('[Finalize] Generating final report...');

  const lines: string[] = [];

  // Header
  lines.push(`# Run Report: ${state.run_id}`);
  lines.push('');
  lines.push(`**Status:** ${state.status}`);
  lines.push(`**Created:** ${state.created_at}`);
  lines.push(`**Completed:** ${new Date().toISOString()}`);
  lines.push('');

  // User Goal
  lines.push('## User Goal');
  lines.push(state.user_goal);
  lines.push('');

  // Summary Statistics
  lines.push('## Summary');
  lines.push(`- Total dispatches: ${state.iteration_counters.total_dispatches}`);
  lines.push(`- Debug iterations: ${state.iteration_counters.debug_iterations}`);
  lines.push(`- Reports generated: ${state.reports.length}`);
  lines.push('');

  // Verification Results
  if (state.verification_results) {
    lines.push('## Verification Results');
    lines.push(`**Overall:** ${state.verification_results.all_passed ? 'PASSED' : 'FAILED'}`);
    lines.push('');

    for (const result of state.verification_results.command_results) {
      lines.push(`### \`${result.cmd}\``);
      lines.push(`- Status: ${result.passed ? 'PASSED' : 'FAILED'}`);
      lines.push(`- Exit code: ${result.exit_code}`);
      if (!result.passed && result.stderr) {
        lines.push('- Error output:');
        lines.push('```');
        lines.push(result.stderr.slice(0, 1000));
        lines.push('```');
      }
      lines.push('');
    }
  }

  // Files Changed
  const allFilesModified = new Set<string>();
  const allFilesCreated = new Set<string>();
  const allFilesDeleted = new Set<string>();

  for (const report of state.reports) {
    if (report.changes) {
      report.changes.files_modified?.forEach(f => allFilesModified.add(f));
      report.changes.files_created?.forEach(f => allFilesCreated.add(f));
      report.changes.files_deleted?.forEach(f => allFilesDeleted.add(f));
    }
  }

  if (allFilesModified.size > 0 || allFilesCreated.size > 0 || allFilesDeleted.size > 0) {
    lines.push('## Files Changed');

    if (allFilesCreated.size > 0) {
      lines.push('**Created:**');
      for (const file of allFilesCreated) {
        lines.push(`- ${file}`);
      }
      lines.push('');
    }

    if (allFilesModified.size > 0) {
      lines.push('**Modified:**');
      for (const file of allFilesModified) {
        lines.push(`- ${file}`);
      }
      lines.push('');
    }

    if (allFilesDeleted.size > 0) {
      lines.push('**Deleted:**');
      for (const file of allFilesDeleted) {
        lines.push(`- ${file}`);
      }
      lines.push('');
    }
  }

  // Error (if any)
  if (state.error) {
    lines.push('## Error');
    lines.push(state.error);
    lines.push('');
  }

  const finalReport = lines.join('\n');
  console.log(`[Finalize] Report generated (${finalReport.length} chars)`);

  return {
    final_report: finalReport,
    updated_at: new Date().toISOString(),
  };
}
