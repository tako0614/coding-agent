/**
 * Adjust Dispatch Node
 * Handles small adjustment tasks when plan_next decides adjustments are needed
 *
 * This node creates and executes 1-3 small fix/adjustment tasks
 * before returning to plan_next for re-evaluation
 */

import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { DAGNode, WorkReport, DAG } from '@supervisor/protocol';
import { createDAGId } from '@supervisor/protocol';
import type { ParallelSupervisorStateType } from '../parallel-state.js';
import { getOpenAIConfig, getDAGModel, getExecutorMode } from '../../services/settings-store.js';
import { log as eventLog } from '../../services/event-bus.js';
import { createWorkerPool } from '../../workers/index.js';
import { v4 as uuidv4 } from 'uuid';

const ADJUST_PROMPT = `You are creating small adjustment tasks to fix issues.

Based on the adjustment reason provided, create 1-3 small, focused tasks to address the issue.
These should be quick fixes, not major refactoring.

Output JSON array of tasks:
[
  {
    "task_id": "adj-1",
    "name": "Fix X",
    "description": "What to fix and how",
    "executor_preference": "codex" or "claude"
  }
]

Rules:
- Maximum 3 tasks
- Each task should be small and focused
- Use "codex" for code changes, "claude" for complex reasoning
- Task descriptions should be clear and actionable`;

interface AdjustTask {
  task_id: string;
  name: string;
  description: string;
  executor_preference: 'codex' | 'claude';
}

/**
 * Adjust dispatch node - creates and executes small adjustment tasks
 */
export async function adjustDispatchNode(
  state: ParallelSupervisorStateType
): Promise<Partial<ParallelSupervisorStateType>> {
  console.log('[AdjustDispatch] Creating adjustment tasks...');
  eventLog(state.run_id, 'info', 'supervisor', '🔧 Creating adjustment tasks...');

  const adjustReason = state.adjust_reason ?? 'Fix remaining issues';

  // Check OpenAI config
  const config = getOpenAIConfig();
  if (!config) {
    eventLog(state.run_id, 'warn', 'supervisor', 'No OpenAI config, skipping adjustments');
    return {
      status: 'planning',
      adjust_reason: undefined,
      updated_at: new Date().toISOString(),
    };
  }

  try {
    // Build context for adjustment planning
    const contextParts: string[] = [];
    contextParts.push(`# Adjustment Reason\n${adjustReason}`);
    contextParts.push(`\n# Goal\n${state.user_goal}`);

    // Add recent task reports
    if (state.reports && state.reports.length > 0) {
      contextParts.push('\n# Recent Task Results');
      for (const report of state.reports.slice(-10)) {
        const status = report.status === 'done' ? '✓' : '✗';
        contextParts.push(`${status} ${report.order_id}: ${report.summary}`);
        if (report.error) {
          contextParts.push(`  Error: ${report.error.message}`);
        }
      }
    }

    const model = new ChatOpenAI({
      model: getDAGModel(),
      temperature: 0.2,
      apiKey: config.apiKey,
      configuration: config.baseUrl ? { baseURL: config.baseUrl } : undefined,
    });

    const response = await model.invoke([
      new SystemMessage(ADJUST_PROMPT),
      new HumanMessage(contextParts.join('\n')),
    ]);

    const content = response.content as string;

    // Parse tasks
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      eventLog(state.run_id, 'warn', 'supervisor', 'No adjustment tasks created');
      return {
        status: 'planning',
        adjust_reason: undefined,
        updated_at: new Date().toISOString(),
      };
    }

    const tasks = JSON.parse(jsonMatch[0]) as AdjustTask[];
    if (tasks.length === 0) {
      eventLog(state.run_id, 'info', 'supervisor', 'No adjustments needed');
      return {
        status: 'planning',
        adjust_reason: undefined,
        updated_at: new Date().toISOString(),
      };
    }

    eventLog(state.run_id, 'info', 'supervisor', `🔧 Dispatching ${tasks.length} adjustment task(s)`);

    // Convert to DAGNodes
    const now = new Date().toISOString();
    const dagNodes: DAGNode[] = tasks.slice(0, 3).map((task, i) => ({
      task_id: `adj-${uuidv4().slice(0, 8)}`,
      name: task.name,
      description: task.description,
      dependencies: [],
      status: 'pending' as const,
      executor_preference: task.executor_preference,
      priority: 1,
    }));

    // Create adjustment DAG
    const adjustDag: DAG = {
      dag_id: createDAGId(),
      run_id: state.run_id,
      nodes: dagNodes,
      edges: [],
      created_at: now,
      updated_at: now,
    };

    // Execute adjustment tasks
    const executorMode = getExecutorMode();
    const pool = createWorkerPool(
      { min_workers: dagNodes.length, max_workers: dagNodes.length },
      state.repo_path,
      state.run_id,
      {
        userGoal: state.user_goal,
        repoContext: state.repo_context,
        dag: adjustDag,
        executorMode,
      }
    );

    await pool.initialize();

    const adjustReports: WorkReport[] = [];

    try {
      // Execute all tasks
      const promises = dagNodes.map(async (task) => {
        eventLog(state.run_id, 'info', 'supervisor', `🔧 Adjusting: ${task.name}`);
        const report = await pool.executeTask(task);
        if (report) {
          adjustReports.push(report);
          const status = report.status === 'done' ? '✓' : '✗';
          eventLog(state.run_id, 'info', 'supervisor', `${status} Adjustment: ${task.name}`);
        }
      });

      await Promise.all(promises);
    } finally {
      await pool.shutdown();
    }

    // Merge adjustment reports with existing reports
    const allReports = [...(state.reports ?? []), ...adjustReports];

    eventLog(state.run_id, 'info', 'supervisor',
      `🔧 Adjustments complete: ${adjustReports.filter(r => r.status === 'done').length}/${adjustReports.length} succeeded`);

    return {
      reports: allReports,
      status: 'verifying', // Go back to plan_next
      adjust_reason: undefined,
      updated_at: new Date().toISOString(),
    };
  } catch (error) {
    console.error('[AdjustDispatch] Error:', error);
    eventLog(state.run_id, 'error', 'supervisor', `Adjustment error: ${error}`);
    return {
      status: 'planning',
      adjust_reason: undefined,
      updated_at: new Date().toISOString(),
    };
  }
}
