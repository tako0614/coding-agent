/**
 * Agent Store
 * Stores SupervisorAgent instances for restart functionality
 */

import type { SupervisorAgent } from './agent.js';

class AgentStore {
  private agents: Map<string, SupervisorAgent> = new Map();

  /**
   * Store an agent instance
   */
  set(runId: string, agent: SupervisorAgent): void {
    this.agents.set(runId, agent);
  }

  /**
   * Get an agent instance
   */
  get(runId: string): SupervisorAgent | undefined {
    return this.agents.get(runId);
  }

  /**
   * Check if an agent exists
   */
  has(runId: string): boolean {
    return this.agents.has(runId);
  }

  /**
   * Delete an agent instance
   */
  delete(runId: string): boolean {
    return this.agents.delete(runId);
  }

  /**
   * Clear all agents
   */
  clear(): void {
    this.agents.clear();
  }

  /**
   * Get all run IDs with stored agents
   */
  getRunIds(): string[] {
    return Array.from(this.agents.keys());
  }
}

// Singleton instance
export const agentStore = new AgentStore();
