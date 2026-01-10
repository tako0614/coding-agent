/**
 * TaskDecompose Node
 * Breaks down the spec into WorkOrders
 */

import type { WorkOrder } from '@supervisor/protocol';
import { createWorkOrderId } from '@supervisor/protocol';
import type { SupervisorStateType } from '../state.js';

export async function decomposeNode(
  state: SupervisorStateType
): Promise<Partial<SupervisorStateType>> {
  console.log('[Decompose] Breaking down spec into work orders...');

  if (!state.spec) {
    throw new Error('No specification available for decomposition');
  }

  const workOrders: WorkOrder[] = [];

  // Create a single implementation WorkOrder from the spec
  // In a more sophisticated version, this would use an LLM to decompose
  const implementOrder: WorkOrder = {
    order_id: createWorkOrderId(),
    run_id: state.run_id,
    task_kind: 'implement',
    repo: {
      path: state.repo_path,
      base_commit: state.base_commit,
    },
    objective: state.user_goal,
    acceptance_criteria: state.spec.acceptance_criteria,
    verification: {
      commands: state.spec.verification_commands.map(cmd => ({
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
      priority: 5,
      retry_count: 0,
      max_retries: 3,
    },
  };

  workOrders.push(implementOrder);

  console.log(`[Decompose] Created ${workOrders.length} work order(s)`);

  return {
    task_queue: workOrders,
    updated_at: new Date().toISOString(),
  };
}
