/**
 * Agent Store
 * Stores SupervisorAgent instances for restart functionality
 * Implements LRU eviction and TTL-based expiration
 */

import type { SupervisorAgent } from './agent.js';
import { logger } from '../services/logger.js';

/** Maximum number of agents to keep in memory */
const MAX_AGENTS = 50;

/** TTL for inactive agents (30 minutes) */
const AGENT_TTL_MS = 30 * 60 * 1000;

/** Cleanup interval (5 minutes) */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

interface AgentEntry {
  agent: SupervisorAgent;
  lastAccessedAt: number;
  createdAt: number;
}

class AgentStore {
  private agents: Map<string, AgentEntry> = new Map();
  private agentOrder: string[] = []; // Track insertion order for LRU cleanup
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    // Start periodic cleanup
    this.startPeriodicCleanup();
  }

  /**
   * Start periodic cleanup timer
   */
  private startPeriodicCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredAgents();
    }, CLEANUP_INTERVAL_MS);

    // Don't prevent Node.js from exiting
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Stop periodic cleanup (for testing or shutdown)
   */
  stopPeriodicCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Store an agent instance
   */
  set(runId: string, agent: SupervisorAgent): void {
    const now = Date.now();

    // If already exists, update entry
    if (this.agents.has(runId)) {
      this.agentOrder = this.agentOrder.filter(id => id !== runId);
    }

    this.agents.set(runId, {
      agent,
      lastAccessedAt: now,
      createdAt: now,
    });
    this.agentOrder.push(runId);

    // Clean up old agents if over limit
    this.cleanupOldAgents();
  }

  /**
   * Dispose an agent if it has a dispose method
   */
  private disposeAgent(agent: SupervisorAgent): void {
    try {
      // Call cancel to abort any ongoing operations
      if (agent.canRestart()) {
        // Agent is already in terminal state, no need to cancel
      } else {
        agent.cancel('Agent evicted from store');
      }
    } catch (error) {
      logger.error('Error disposing agent', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Remove oldest agents when over limit (LRU eviction)
   */
  private cleanupOldAgents(): void {
    while (this.agentOrder.length > MAX_AGENTS) {
      const oldestId = this.agentOrder.shift();
      if (oldestId) {
        const entry = this.agents.get(oldestId);
        if (entry) {
          logger.debug('Evicting agent from store (LRU)', {
            runId: oldestId,
            age: Date.now() - entry.createdAt,
          });
          this.disposeAgent(entry.agent);
        }
        this.agents.delete(oldestId);
      }
    }
  }

  /**
   * Remove agents that haven't been accessed within TTL
   */
  private cleanupExpiredAgents(): void {
    const now = Date.now();
    const expiredIds: string[] = [];

    for (const [runId, entry] of this.agents) {
      const age = now - entry.lastAccessedAt;
      if (age > AGENT_TTL_MS) {
        // Check if agent is in terminal state
        const agent = entry.agent;
        if (agent.canRestart()) {
          // Agent is in completed/failed state and expired
          expiredIds.push(runId);
        }
      }
    }

    if (expiredIds.length > 0) {
      logger.info('Cleaning up expired agents', {
        count: expiredIds.length,
        runIds: expiredIds,
      });

      for (const runId of expiredIds) {
        const entry = this.agents.get(runId);
        if (entry) {
          this.disposeAgent(entry.agent);
        }
        this.agentOrder = this.agentOrder.filter(id => id !== runId);
        this.agents.delete(runId);
      }
    }
  }

  /**
   * Get an agent instance (updates LRU order and last accessed time)
   */
  get(runId: string): SupervisorAgent | undefined {
    const entry = this.agents.get(runId);
    if (entry) {
      // Update last accessed time
      entry.lastAccessedAt = Date.now();

      // Update LRU order: move to end (most recently used)
      this.agentOrder = this.agentOrder.filter(id => id !== runId);
      this.agentOrder.push(runId);

      return entry.agent;
    }
    return undefined;
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
    this.agentOrder = this.agentOrder.filter(id => id !== runId);
    return this.agents.delete(runId);
  }

  /**
   * Explicitly remove completed/failed agents (can be called after run completion)
   */
  removeCompleted(runId: string): boolean {
    const entry = this.agents.get(runId);
    if (entry && entry.agent.canRestart()) {
      logger.debug('Removing completed agent', { runId });
      return this.delete(runId);
    }
    return false;
  }

  /**
   * Clear all agents
   */
  clear(): void {
    this.agents.clear();
    this.agentOrder = [];
    logger.info('Agent store cleared');
  }

  /**
   * Get number of stored agents
   */
  size(): number {
    return this.agents.size;
  }

  /**
   * Get all run IDs with stored agents
   */
  getRunIds(): string[] {
    return Array.from(this.agents.keys());
  }

  /**
   * Get store statistics for monitoring
   */
  getStats(): {
    totalAgents: number;
    oldestAgentAge: number | null;
    averageAge: number | null;
  } {
    const now = Date.now();
    const entries = Array.from(this.agents.values());

    if (entries.length === 0) {
      return { totalAgents: 0, oldestAgentAge: null, averageAge: null };
    }

    const ages = entries.map(e => now - e.createdAt);
    const oldestAge = Math.max(...ages);
    const avgAge = ages.reduce((sum, age) => sum + age, 0) / ages.length;

    return {
      totalAgents: entries.length,
      oldestAgentAge: oldestAge,
      averageAge: avgAge,
    };
  }
}

// Singleton instance
export const agentStore = new AgentStore();
