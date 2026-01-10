/**
 * Supervisor LangGraph Definition
 *
 * Graph Flow:
 *
 * START -> intake -> spec_draft -> decompose -> route_executor -> dispatch
 *                                                    ^              |
 *                                                    |              v
 *                                            analyze_failures <- verify -> loop_control
 *                                                                              |
 *                                                                              v
 *                                                                          finalize -> END
 */

import { StateGraph, END, START } from '@langchain/langgraph';
import { SupervisorState, type SupervisorStateType, createInitialState } from './state.js';
import {
  intakeNode,
  specDraftNode,
  decomposeNode,
  routeExecutorNode,
  dispatchNode,
  verifyNode,
  analyzeFailuresNode,
  loopControlNode,
  finalizeNode,
  shouldContinue,
} from './nodes/index.js';

/**
 * Create the supervisor graph
 */
export function createSupervisorGraph() {
  const graph = new StateGraph(SupervisorState)
    // Add nodes
    .addNode('intake', intakeNode)
    .addNode('spec_draft', specDraftNode)
    .addNode('decompose', decomposeNode)
    .addNode('route_executor', routeExecutorNode)
    .addNode('dispatch', dispatchNode)
    .addNode('verify', verifyNode)
    .addNode('analyze_failures', analyzeFailuresNode)
    .addNode('loop_control', loopControlNode)
    .addNode('finalize', finalizeNode)

    // Define edges
    .addEdge(START, 'intake')
    .addEdge('intake', 'spec_draft')
    .addEdge('spec_draft', 'decompose')
    .addEdge('decompose', 'route_executor')
    .addEdge('route_executor', 'dispatch')
    .addEdge('dispatch', 'verify')
    .addEdge('verify', 'loop_control')

    // Conditional routing from loop_control
    .addConditionalEdges('loop_control', (state: SupervisorStateType) => {
      const decision = shouldContinue(state);
      console.log(`[Graph] Loop control decision: ${decision}`);
      return decision;
    }, {
      dispatch: 'route_executor',
      analyze_failures: 'analyze_failures',
      finalize: 'finalize',
    })

    // analyze_failures goes back to route_executor
    .addEdge('analyze_failures', 'route_executor')

    // finalize ends the graph
    .addEdge('finalize', END);

  return graph.compile();
}

// Export state utilities
export { SupervisorState, type SupervisorStateType, createInitialState };

/**
 * Run the supervisor graph with a user goal
 */
export async function runSupervisor(
  userGoal: string,
  repoPath: string,
  runId?: string
): Promise<SupervisorStateType> {
  const graph = createSupervisorGraph();

  const { createRunId } = await import('@supervisor/protocol');
  const actualRunId = runId ?? createRunId();

  const initialState = createInitialState(actualRunId, userGoal, repoPath);

  console.log(`[Supervisor] Starting run ${actualRunId}`);
  console.log(`[Supervisor] Goal: ${userGoal.slice(0, 100)}...`);
  console.log(`[Supervisor] Repo: ${repoPath}`);

  const finalState = await graph.invoke(initialState);

  console.log(`[Supervisor] Run ${actualRunId} completed with status: ${finalState.status}`);

  return finalState;
}
