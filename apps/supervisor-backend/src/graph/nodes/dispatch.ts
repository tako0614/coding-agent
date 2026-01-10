/**
 * Dispatch Node
 * Executes the current task using the selected executor
 */

import type { WorkReport } from '@supervisor/protocol';
import { createCodexAdapter } from '@supervisor/executor-codex';
import { createClaudeAdapter } from '@supervisor/executor-claude';
import type { SupervisorStateType } from '../state.js';

export async function dispatchNode(
  state: SupervisorStateType
): Promise<Partial<SupervisorStateType>> {
  console.log('[Dispatch] Executing current task...');

  if (!state.current_task) {
    console.log('[Dispatch] No current task to execute');
    return {};
  }

  const task = state.current_task;
  console.log(`[Dispatch] Task: ${task.task_kind} - ${task.objective.slice(0, 50)}...`);

  let report: WorkReport;

  try {
    // Select executor based on task routing
    // For MVP, we'll try Codex first, then Claude as fallback
    const codexAdapter = createCodexAdapter({
      sandbox: task.tooling.sandbox,
      approvalLevel: task.tooling.approval_required ? 'suggest' : 'full-auto',
    });

    const claudeAdapter = createClaudeAdapter({
      allowTools: true,
    });

    // Check which executor is available
    const codexAvailable = await codexAdapter.isAvailable();
    const claudeAvailable = await claudeAdapter.isAvailable();

    console.log(`[Dispatch] Codex available: ${codexAvailable}, Claude available: ${claudeAvailable}`);

    if (codexAvailable && task.task_kind !== 'spec' && task.task_kind !== 'review') {
      console.log('[Dispatch] Using Codex executor');
      report = await codexAdapter.execute(task, {
        cwd: task.repo.path,
        timeout: 600000,
        onOutput: (type, data) => {
          console.log(`[Codex ${type}] ${data.slice(0, 200)}...`);
        },
      });
    } else if (claudeAvailable) {
      console.log('[Dispatch] Using Claude executor');
      report = await claudeAdapter.execute(task, {
        cwd: task.repo.path,
        timeout: 900000,
        onOutput: (type, data) => {
          console.log(`[Claude ${type}] ${data.slice(0, 200)}...`);
        },
      });
    } else {
      // No executor available - create a failed report
      const { createWorkReportId } = await import('@supervisor/protocol');
      report = {
        report_id: createWorkReportId(),
        order_id: task.order_id,
        run_id: task.run_id,
        status: 'failed',
        summary: 'No executor available (neither Codex nor Claude CLI found)',
        commands_run: [],
        verification: {
          passed: false,
          details: 'No executor available',
        },
        error: {
          code: 'NO_EXECUTOR',
          message: 'Neither Codex nor Claude CLI is available in PATH',
        },
      };
    }
  } catch (error) {
    const { createWorkReportId } = await import('@supervisor/protocol');
    const errorMessage = error instanceof Error ? error.message : String(error);

    report = {
      report_id: createWorkReportId(),
      order_id: task.order_id,
      run_id: task.run_id,
      status: 'failed',
      summary: `Execution failed: ${errorMessage}`,
      commands_run: [],
      verification: {
        passed: false,
        details: errorMessage,
      },
      error: {
        message: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      },
    };
  }

  console.log(`[Dispatch] Task completed with status: ${report.status}`);

  return {
    reports: [report],
    current_task: undefined,
    updated_at: new Date().toISOString(),
  };
}
