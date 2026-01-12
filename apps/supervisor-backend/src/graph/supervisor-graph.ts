/**
 * Simplified Supervisor LangGraph Definition
 *
 * Flow: START -> supervisor_node <-> dispatch_node -> END
 *
 * The Supervisor Agent (GPT via Copilot API) orchestrates everything:
 * - Reads repo structure and AGENTS.md
 * - Breaks down tasks and spawns workers
 * - Reviews results and adjusts
 * - All work (including reviews) done by Workers (Claude Code/Codex)
 */

import { StateGraph, END, START, Annotation } from '@langchain/langgraph';
import type { WorkerExecutorType, WorkReport, DAGNode } from '@supervisor/protocol';
import { createRunId, createTaskId, createWorkReportId } from '@supervisor/protocol';
import {
  createSupervisorAgent,
  type WorkerTask,
  type WorkerTaskResult,
} from '../supervisor/index.js';
import { WorkerPool, createWorkerPool } from '../workers/index.js';
import { log as eventLog } from '../services/event-bus.js';
import { logger } from '../services/logger.js';
import { getExecutorMode } from '../services/settings-store.js';

// =============================================================================
// State Definition
// =============================================================================

export type SimplifiedRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const SimplifiedSupervisorState = Annotation.Root({
  // Core identifiers
  run_id: Annotation<string>(),
  status: Annotation<SimplifiedRunStatus>(),

  // User input
  user_goal: Annotation<string>(),
  repo_path: Annotation<string>(),

  // Project reference (optional)
  project_id: Annotation<string | undefined>(),

  // Results
  reports: Annotation<WorkReport[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),

  // Supervisor thinking/output
  supervisor_thinking: Annotation<string | undefined>(),
  final_summary: Annotation<string | undefined>(),
  error: Annotation<string | undefined>(),

  // Worker pool reference (for cleanup)
  worker_pool: Annotation<WorkerPool | undefined>(),

  // Timestamps
  created_at: Annotation<string>(),
  updated_at: Annotation<string>(),
});

export type SimplifiedSupervisorStateType = typeof SimplifiedSupervisorState.State;

// =============================================================================
// Nodes
// =============================================================================

/**
 * Supervisor Node
 * Runs the Supervisor Agent which uses Copilot API (GPT) to orchestrate
 */
async function supervisorNode(
  state: SimplifiedSupervisorStateType
): Promise<Partial<SimplifiedSupervisorStateType>> {
  logger.info('Running Supervisor Agent', { runId: state.run_id });
  eventLog(state.run_id, 'info', 'supervisor', '🧠 Starting Supervisor Agent');

  // Create worker executor function that uses the worker pool
  const workerExecutor = async (tasks: WorkerTask[]): Promise<WorkerTaskResult[]> => {
    const results: WorkerTaskResult[] = [];
    const executorMode = getExecutorMode();

    // Create worker pool
    const pool = createWorkerPool(
      state.repo_path,
      state.run_id,
      {
        userGoal: state.user_goal,
        executorMode,
      }
    );

    try {
      await pool.initialize();

      // Execute each task
      for (const task of tasks) {
        const startTime = Date.now();
        eventLog(state.run_id, 'info', 'codex', `▶ Starting: ${task.instruction.slice(0, 50)}...`);

        try {
          // Convert to DAGNode format expected by worker pool
          const dagNode: DAGNode = {
            task_id: task.task_id,
            name: task.instruction.slice(0, 50),
            description: task.instruction,
            executor_preference: task.executor as WorkerExecutorType,
            dependencies: [],
            priority: task.priority ?? 5,
            estimated_duration_ms: 300_000, // 5 minutes
            status: 'pending',
          };

          const report = await pool.executeTask(dagNode);

          const duration = Date.now() - startTime;
          if (report) {
            results.push({
              task_id: task.task_id,
              instruction: task.instruction,
              executor: task.executor,
              success: report.status === 'done',
              summary: report.summary,
              report,
              duration_ms: duration,
              completed_at: new Date().toISOString(),
            });
            eventLog(state.run_id, 'info', 'codex',
              `✓ Completed: ${task.instruction.slice(0, 50)}... (${Math.round(duration / 1000)}s)`);
          } else {
            results.push({
              task_id: task.task_id,
              instruction: task.instruction,
              executor: task.executor,
              success: false,
              error: 'No worker available',
              duration_ms: duration,
              completed_at: new Date().toISOString(),
            });
            eventLog(state.run_id, 'error', 'codex',
              `✗ Failed: ${task.instruction.slice(0, 50)}... - No worker available`);
          }
        } catch (error) {
          const duration = Date.now() - startTime;
          const errorMsg = error instanceof Error ? error.message : String(error);
          results.push({
            task_id: task.task_id,
            instruction: task.instruction,
            executor: task.executor,
            success: false,
            error: errorMsg,
            duration_ms: duration,
            completed_at: new Date().toISOString(),
          });
          eventLog(state.run_id, 'error', 'codex',
            `✗ Failed: ${task.instruction.slice(0, 50)}... - ${errorMsg}`);
        }
      }
    } finally {
      await pool.shutdown();
    }

    return results;
  };

  // Create and run Supervisor Agent
  const agent = createSupervisorAgent({
    repoPath: state.repo_path,
    userGoal: state.user_goal,
    events: {
      onThinking: (content) => {
        logger.debug('Supervisor thinking', { content: content.slice(0, 200) });
      },
      onWorkerStart: (task) => {
        eventLog(state.run_id, 'info', 'supervisor', `🚀 Spawning worker: ${task.instruction.slice(0, 50)}...`);
      },
      onWorkerComplete: (result) => {
        const status = result.success ? '✓' : '✗';
        eventLog(state.run_id, 'info', 'supervisor',
          `${status} Worker result: ${result.instruction.slice(0, 50)}...`);
      },
    },
    workerExecutor,
  });

  const finalState = await agent.run();

  // Collect reports from completed tasks
  const reports: WorkReport[] = finalState.completed_tasks
    .filter((t) => t.report)
    .map((t) => t.report!);

  if (finalState.phase === 'completed') {
    eventLog(state.run_id, 'info', 'supervisor', `✅ Completed: ${finalState.final_summary?.slice(0, 100)}...`);
    return {
      status: 'completed',
      reports,
      final_summary: finalState.final_summary,
      updated_at: new Date().toISOString(),
    };
  } else {
    eventLog(state.run_id, 'error', 'supervisor', `❌ Failed: ${finalState.error}`);
    return {
      status: 'failed',
      reports,
      error: finalState.error,
      updated_at: new Date().toISOString(),
    };
  }
}

// =============================================================================
// Graph Definition
// =============================================================================

/**
 * Create the simplified supervisor graph
 */
export function createSimplifiedSupervisorGraph() {
  const graph = new StateGraph(SimplifiedSupervisorState)
    .addNode('supervisor', supervisorNode)
    .addEdge(START, 'supervisor')
    .addEdge('supervisor', END);

  return graph.compile();
}

// =============================================================================
// Runner
// =============================================================================

export interface RunSimplifiedSupervisorOptions {
  userGoal: string;
  repoPath: string;
  runId?: string;
  projectId?: string;
}

/**
 * Run the simplified supervisor graph
 */
export async function runSimplifiedSupervisor(
  options: RunSimplifiedSupervisorOptions
): Promise<SimplifiedSupervisorStateType> {
  const graph = createSimplifiedSupervisorGraph();

  const runId = options.runId ?? createRunId();
  const now = new Date().toISOString();

  const initialState: Partial<SimplifiedSupervisorStateType> = {
    run_id: runId,
    status: 'pending',
    user_goal: options.userGoal,
    repo_path: options.repoPath,
    project_id: options.projectId,
    reports: [],
    created_at: now,
    updated_at: now,
  };

  logger.info('Starting simplified supervisor', {
    runId,
    goal: options.userGoal.slice(0, 100),
    repo: options.repoPath,
  });
  eventLog(runId, 'info', 'supervisor', '🚀 Starting simplified supervisor', {
    goal: options.userGoal.slice(0, 100),
    repo: options.repoPath,
  });

  const finalState = await graph.invoke(initialState);

  logger.info('Simplified supervisor completed', {
    runId,
    status: finalState.status,
  });

  return finalState;
}

// Already exported above - no need for duplicate exports
