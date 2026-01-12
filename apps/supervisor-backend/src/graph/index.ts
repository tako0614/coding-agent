/**
 * Supervisor LangGraph Definition
 *
 * Flow: START -> supervisor -> END
 *
 * The Supervisor Agent (GPT via Copilot API) handles everything:
 * - Reads repo and AGENTS.md
 * - Spawns workers for tasks
 * - Reviews and adjusts
 * - All work done by Workers (Claude/Codex)
 */

import {
  createSimplifiedSupervisorGraph,
  runSimplifiedSupervisor,
  SimplifiedSupervisorState,
  type SimplifiedSupervisorStateType,
  type RunSimplifiedSupervisorOptions,
  type SimplifiedRunStatus,
} from './supervisor-graph.js';

// Re-export all
export {
  createSimplifiedSupervisorGraph,
  runSimplifiedSupervisor,
  SimplifiedSupervisorState,
  type SimplifiedSupervisorStateType,
  type RunSimplifiedSupervisorOptions,
  type SimplifiedRunStatus,
};

// Convenience aliases
export {
  createSimplifiedSupervisorGraph as createSupervisorGraph,
  runSimplifiedSupervisor as runSupervisor,
};
