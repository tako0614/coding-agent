/**
 * Plan Next Node
 * Reviews results and decides whether to continue with more tasks or finish
 */

import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { ParallelSupervisorStateType } from '../parallel-state.js';
import { getOpenAIConfig, getDAGModel } from '../../services/settings-store.js';
import { log as eventLog } from '../../services/event-bus.js';

const PLAN_NEXT_PROMPT = `You are reviewing the results of completed tasks and deciding what to do next.

Based on the goal and current progress, decide:
1. CONTINUE - More work needed, create next batch of tasks (for major new work)
2. ADJUST - Small fixes needed before continuing (1-3 quick fix tasks)
3. FINISH - Goal achieved, no more work needed

When to use ADJUST vs CONTINUE:
- ADJUST: Minor issues, typos, small bugs, missing imports, config tweaks (1-3 quick tasks)
- CONTINUE: Significant remaining work, new features, major refactoring

Consider:
- Were all tasks successful?
- Does the current state meet the goal?
- Are there small issues that can be quickly fixed?
- Are there remaining major issues to address?

Output your decision as JSON:
{"decision": "CONTINUE", "reason": "..."}
or
{"decision": "ADJUST", "reason": "...", "adjustments": "what needs to be fixed"}
or
{"decision": "FINISH", "reason": "..."}`;

interface PlanNextDecision {
  decision: 'CONTINUE' | 'ADJUST' | 'FINISH';
  reason: string;
  adjustments?: string; // What needs to be fixed (for ADJUST)
}

/**
 * Plan next node - decides whether to continue or finish
 */
export async function planNextNode(
  state: ParallelSupervisorStateType
): Promise<Partial<ParallelSupervisorStateType>> {
  const iteration = state.iteration_count ?? 0;
  console.log(`[PlanNext] Reviewing results and planning next step (iteration ${iteration})...`);
  eventLog(state.run_id, 'info', 'supervisor', `🤔 Reviewing results (iteration ${iteration})...`);

  const progress = state.dag_progress;
  const reports = state.reports ?? [];

  // Quick check: if all tasks succeeded, let LLM decide if goal is met
  const allSucceeded = progress && progress.failed === 0 && progress.completed === progress.total;

  // Build context
  const contextParts: string[] = [];
  contextParts.push(`# Goal\n${state.user_goal}`);
  contextParts.push(`\n# Iteration ${iteration} Results`);

  if (progress) {
    contextParts.push(`- Total tasks: ${progress.total}`);
    contextParts.push(`- Completed: ${progress.completed}`);
    contextParts.push(`- Failed: ${progress.failed}`);
  }

  contextParts.push('\n## Task Reports:');
  for (const report of reports.slice(-20)) { // Last 20 reports
    const status = report.status === 'done' ? '✓' : '✗';
    contextParts.push(`${status} ${report.order_id}: ${report.summary}`);
    if (report.error) {
      contextParts.push(`  Error: ${report.error.message}`);
    }
    if (report.changes?.files_modified?.length) {
      contextParts.push(`  Modified: ${report.changes.files_modified.join(', ')}`);
    }
  }

  // Check OpenAI config
  const config = getOpenAIConfig();
  if (!config) {
    // Fallback: continue if failures, finish if all succeeded
    if (allSucceeded) {
      eventLog(state.run_id, 'info', 'supervisor', '✅ All tasks completed, finishing');
      return {
        status: 'completed',
        updated_at: new Date().toISOString(),
      };
    } else {
      eventLog(state.run_id, 'info', 'supervisor', '🔄 Some tasks failed, continuing');
      return {
        status: 'planning',
        updated_at: new Date().toISOString(),
      };
    }
  }

  try {
    const model = new ChatOpenAI({
      model: getDAGModel(),
      temperature: 0.2,
      apiKey: config.apiKey,
      configuration: config.baseUrl ? { baseURL: config.baseUrl } : undefined,
    });

    const response = await model.invoke([
      new SystemMessage(PLAN_NEXT_PROMPT),
      new HumanMessage(contextParts.join('\n')),
    ]);

    const content = response.content as string;

    // Parse decision
    const jsonMatch = content.match(/\{[^}]+\}/);
    if (jsonMatch) {
      try {
        const decision = JSON.parse(jsonMatch[0]) as PlanNextDecision;

        if (decision.decision === 'FINISH') {
          eventLog(state.run_id, 'info', 'supervisor', `✅ Decision: FINISH - ${decision.reason}`);
          return {
            status: 'completed',
            updated_at: new Date().toISOString(),
          };
        } else if (decision.decision === 'ADJUST') {
          eventLog(state.run_id, 'info', 'supervisor', `🔧 Decision: ADJUST - ${decision.reason}`);
          return {
            status: 'adjusting',
            adjust_reason: decision.adjustments ?? decision.reason,
            updated_at: new Date().toISOString(),
          };
        } else {
          eventLog(state.run_id, 'info', 'supervisor', `🔄 Decision: CONTINUE - ${decision.reason}`);
          return {
            status: 'planning',
            updated_at: new Date().toISOString(),
          };
        }
      } catch {
        // Parse error, default based on success
      }
    }

    // Default fallback
    if (allSucceeded) {
      eventLog(state.run_id, 'info', 'supervisor', '✅ All tasks completed, finishing');
      return {
        status: 'completed',
        updated_at: new Date().toISOString(),
      };
    } else {
      eventLog(state.run_id, 'info', 'supervisor', '🔄 Continuing with more tasks');
      return {
        status: 'planning',
        updated_at: new Date().toISOString(),
      };
    }
  } catch (error) {
    console.error('[PlanNext] Error:', error);
    // On error, finish if all succeeded, otherwise continue
    return {
      status: allSucceeded ? 'completed' : 'planning',
      updated_at: new Date().toISOString(),
    };
  }
}
