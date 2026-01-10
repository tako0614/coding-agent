/**
 * Intake Node
 * Normalizes user input and initializes the run
 */

import type { SupervisorStateType } from '../state.js';
import { log as eventLog } from '../../services/event-bus.js';

export async function intakeNode(
  state: SupervisorStateType
): Promise<Partial<SupervisorStateType>> {
  console.log(`[Intake] Processing user goal: ${state.user_goal.slice(0, 100)}...`);

  eventLog(state.run_id, 'info', 'supervisor', `📥 Intake: Processing goal`, {
    node: 'intake',
    goal_preview: state.user_goal.slice(0, 100),
  });

  // Update status to running
  return {
    status: 'running',
    updated_at: new Date().toISOString(),
  };
}
