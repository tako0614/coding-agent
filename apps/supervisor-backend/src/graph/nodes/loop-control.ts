/**
 * LoopControl Node
 * Determines whether to continue iterating or finalize
 */

import type { SupervisorStateType } from '../state.js';

export type LoopDecision = 'continue' | 'finalize' | 'needs_input' | 'give_up';

export async function loopControlNode(
  state: SupervisorStateType
): Promise<Partial<SupervisorStateType>> {
  console.log('[LoopControl] Evaluating loop status...');

  // Check if verification passed
  if (state.verification_results?.all_passed) {
    console.log('[LoopControl] Verification passed - proceeding to finalize');
    return {
      status: 'completed',
      updated_at: new Date().toISOString(),
    };
  }

  // Check iteration limits
  const { debug_iterations, max_debug_iterations } = state.iteration_counters;

  if (debug_iterations >= max_debug_iterations) {
    console.log(`[LoopControl] Max debug iterations (${max_debug_iterations}) reached - giving up`);
    return {
      status: 'failed',
      error: `Failed after ${max_debug_iterations} debug iterations`,
      updated_at: new Date().toISOString(),
    };
  }

  // Check for blocked status in latest report
  const latestReport = state.reports[state.reports.length - 1];
  if (latestReport?.status === 'blocked' || latestReport?.status === 'needs_input') {
    console.log('[LoopControl] Executor is blocked - needs user input');
    return {
      status: 'needs_input',
      updated_at: new Date().toISOString(),
    };
  }

  // Check for consecutive same errors
  if (state.iteration_counters.consecutive_same_error >= 3) {
    console.log('[LoopControl] Same error repeated 3 times - needs user input');
    return {
      status: 'needs_input',
      error: 'Same error repeated multiple times, manual intervention may be needed',
      updated_at: new Date().toISOString(),
    };
  }

  // Continue with another iteration
  console.log(`[LoopControl] Continuing (debug iteration ${debug_iterations + 1}/${max_debug_iterations})`);
  return {
    status: 'running',
    updated_at: new Date().toISOString(),
  };
}

/**
 * Determine the next step based on state
 */
export function shouldContinue(state: SupervisorStateType): string {
  if (state.status === 'completed') {
    return 'finalize';
  }

  if (state.status === 'failed' || state.status === 'needs_input') {
    return 'finalize';
  }

  if (state.task_queue.length > 0 || state.current_task) {
    return 'dispatch';
  }

  // If verification failed but we haven't hit limits, analyze failures
  if (state.verification_results && !state.verification_results.all_passed) {
    return 'analyze_failures';
  }

  return 'finalize';
}
