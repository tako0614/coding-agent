/**
 * RouteExecutor Node
 * Selects which executor (Claude/Codex) to use for a task
 */

import type { WorkOrder, TaskKind, ExecutorType } from '@supervisor/protocol';
import type { SupervisorStateType } from '../state.js';

/**
 * Determine which executor to use based on task kind and policy
 */
function selectExecutor(taskKind: TaskKind, modelPolicy: SupervisorStateType['model_policy']): ExecutorType {
  // Default routing logic based on task type
  switch (taskKind) {
    case 'spec':
    case 'review':
      // Claude is better at specification and review tasks
      return 'claude';
    case 'implement':
    case 'refactor':
    case 'debug':
    case 'test':
      // Codex is better at implementation tasks
      return 'codex';
    default:
      return 'codex';
  }
}

export async function routeExecutorNode(
  state: SupervisorStateType
): Promise<Partial<SupervisorStateType>> {
  console.log('[RouteExecutor] Selecting executor for next task...');

  if (state.task_queue.length === 0) {
    console.log('[RouteExecutor] No tasks in queue');
    return {};
  }

  // Get the next task from queue
  const [nextTask, ...remainingTasks] = state.task_queue;

  if (!nextTask) {
    return {};
  }

  const executor = selectExecutor(nextTask.task_kind, state.model_policy);
  console.log(`[RouteExecutor] Selected ${executor} for ${nextTask.task_kind} task`);

  // Update iteration counters
  const newCounters = {
    ...state.iteration_counters,
    total_dispatches: state.iteration_counters.total_dispatches + 1,
  };

  return {
    current_task: nextTask,
    task_queue: remainingTasks,
    iteration_counters: newCounters,
    updated_at: new Date().toISOString(),
  };
}
