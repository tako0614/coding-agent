/**
 * Parallel Supervisor LangGraph Definition
 *
 * Graph Flow:
 *
 * START -> intake -> read_context -> build_dag -> parallel_dispatch -> verify -> finalize -> END
 *
 * read_context: Reads AGENTS.md, README.md, specs/, etc. from the repository
 * build_dag: Uses LLM to decompose goal into parallel tasks based on repo context
 * parallel_dispatch: Executes tasks using Codex/Claude workers
 *
 * Worker scaling is dynamic based on DAG complexity - the system automatically
 * determines the optimal number of workers based on task dependencies and concurrency.
 */

import { StateGraph, END, START } from '@langchain/langgraph';
import {
  ParallelSupervisorState,
  type ParallelSupervisorStateType,
  createInitialParallelState,
  type ChatMessageInput,
} from './parallel-state.js';
import { intakeNode, verifyNode, finalizeNode } from './nodes/index.js';
import { readContextNode } from './nodes/read-context.js';
import { buildDAGNode } from './nodes/build-dag.js';
import { parallelDispatchNode } from './nodes/parallel-dispatch.js';
import { log as eventLog } from '../services/event-bus.js';

/**
 * Create the parallel supervisor graph
 */
export function createParallelSupervisorGraph() {
  const graph = new StateGraph(ParallelSupervisorState)
    // Add nodes
    .addNode('intake', intakeNode as (state: ParallelSupervisorStateType) => Promise<Partial<ParallelSupervisorStateType>>)
    .addNode('read_context', readContextNode)
    .addNode('build_dag', buildDAGNode)
    .addNode('parallel_dispatch', parallelDispatchNode)
    .addNode('verify', verifyNode as (state: ParallelSupervisorStateType) => Promise<Partial<ParallelSupervisorStateType>>)
    .addNode('finalize', finalizeParallelNode)

    // Define edges
    // START -> intake -> read_context -> build_dag -> parallel_dispatch -> verify -> finalize -> END
    .addEdge(START, 'intake')
    .addEdge('intake', 'read_context')
    .addEdge('read_context', 'build_dag')
    .addEdge('build_dag', 'parallel_dispatch')
    .addEdge('parallel_dispatch', 'verify')

    // Conditional edge from verify
    .addConditionalEdges('verify', (state: ParallelSupervisorStateType) => {
      // Check verification results
      const progress = state.dag_progress;
      if (!progress) {
        return 'finalize';
      }

      // If all tasks completed successfully and verification passed
      if (progress.failed === 0 && progress.completed === progress.total) {
        return 'finalize';
      }

      // If there are failures, still finalize but with error status
      return 'finalize';
    }, {
      finalize: 'finalize',
    })

    .addEdge('finalize', END);

  return graph.compile();
}

/**
 * Finalize node for parallel execution
 */
async function finalizeParallelNode(
  state: ParallelSupervisorStateType
): Promise<Partial<ParallelSupervisorStateType>> {
  console.log('[Finalize] Generating final report...');
  eventLog(state.run_id, 'info', 'supervisor', '📝 Finalize: Generating report...', { node: 'finalize' });

  const progress = state.dag_progress;
  const reports = state.reports;

  // Build final report
  const lines: string[] = [];
  lines.push('# Parallel Execution Report');
  lines.push('');
  lines.push(`## Summary`);
  lines.push(`- **Goal**: ${state.user_goal}`);
  lines.push(`- **Run ID**: ${state.run_id}`);
  lines.push(`- **Status**: ${progress?.failed === 0 ? 'Completed Successfully' : 'Completed with Failures'}`);
  lines.push('');

  if (progress) {
    lines.push('## Progress');
    lines.push(`- Total Tasks: ${progress.total}`);
    lines.push(`- Completed: ${progress.completed}`);
    lines.push(`- Failed: ${progress.failed}`);
    lines.push(`- Completion: ${progress.percentage}%`);
    lines.push('');
  }

  if (state.worker_pool_status) {
    lines.push('## Worker Pool');
    lines.push(`- Total Workers: ${state.worker_pool_status.total_workers}`);
    lines.push(`- Tasks Completed: ${state.worker_pool_status.total_tasks_completed}`);
    lines.push(`- Tasks Failed: ${state.worker_pool_status.total_tasks_failed}`);
    lines.push('');
  }

  if (reports.length > 0) {
    lines.push('## Task Reports');
    lines.push('');
    for (const report of reports) {
      lines.push(`### ${report.order_id}`);
      lines.push(`- **Status**: ${report.status}`);
      lines.push(`- **Summary**: ${report.summary}`);
      if (report.changes?.files_modified?.length) {
        lines.push(`- **Files Modified**: ${report.changes.files_modified.join(', ')}`);
      }
      if (report.error) {
        lines.push(`- **Error**: ${report.error.message}`);
      }
      lines.push('');
    }
  }

  const finalReport = lines.join('\n');
  const status = progress?.failed === 0 ? 'completed' : 'failed';

  const statusEmoji = status === 'completed' ? '✅' : '❌';
  eventLog(state.run_id, status === 'completed' ? 'info' : 'error', 'supervisor',
    `${statusEmoji} Run ${status}: ${progress?.completed ?? 0}/${progress?.total ?? 0} tasks completed`, {
      node: 'finalize',
      status,
      completed: progress?.completed ?? 0,
      failed: progress?.failed ?? 0,
      total: progress?.total ?? 0,
    });

  return {
    final_report: finalReport,
    status,
    updated_at: new Date().toISOString(),
  };
}

// Export state utilities
export { ParallelSupervisorState, type ParallelSupervisorStateType, createInitialParallelState, type ChatMessageInput };

/**
 * Options for running the parallel supervisor
 */
export interface RunParallelSupervisorOptions {
  userGoal: string;
  repoPath: string;
  runId?: string;
  projectId?: string;
  /** Full chat history in OpenAI format for multi-turn conversations */
  chatHistory?: ChatMessageInput[];
}

/**
 * Run the parallel supervisor graph with a user goal
 *
 * Worker pool is automatically scaled based on DAG complexity.
 * No manual configuration required.
 */
export async function runParallelSupervisor(
  userGoalOrOptions: string | RunParallelSupervisorOptions,
  repoPath?: string,
  runId?: string,
  projectId?: string
): Promise<ParallelSupervisorStateType> {
  // Support both old signature and new options object
  let options: RunParallelSupervisorOptions;
  if (typeof userGoalOrOptions === 'string') {
    options = {
      userGoal: userGoalOrOptions,
      repoPath: repoPath!,
      runId,
      projectId,
    };
  } else {
    options = userGoalOrOptions;
  }

  const graph = createParallelSupervisorGraph();

  const { createRunId } = await import('@supervisor/protocol');
  const actualRunId = options.runId ?? createRunId();

  const initialState = createInitialParallelState(
    actualRunId,
    options.userGoal,
    options.repoPath,
    options.projectId,
    options.chatHistory
  );

  console.log(`[ParallelSupervisor] Starting run ${actualRunId}`);
  console.log(`[ParallelSupervisor] Goal: ${options.userGoal.slice(0, 100)}...`);
  console.log(`[ParallelSupervisor] Repo: ${options.repoPath}`);
  if (options.projectId) {
    console.log(`[ParallelSupervisor] Project: ${options.projectId}`);
  }
  if (options.chatHistory?.length) {
    console.log(`[ParallelSupervisor] Chat history: ${options.chatHistory.length} messages`);
  }

  // Log graph start
  eventLog(actualRunId, 'info', 'supervisor', '🚀 Starting parallel supervisor graph', {
    goal: options.userGoal.slice(0, 100),
    repo: options.repoPath,
    project_id: options.projectId,
    chat_history_length: options.chatHistory?.length ?? 0,
  });

  const finalState = await graph.invoke(initialState);

  console.log(`[ParallelSupervisor] Run ${actualRunId} completed with status: ${finalState.status}`);

  return finalState;
}
