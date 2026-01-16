/**
 * Agent Store
 * Stores SupervisorAgent instances for restart functionality
 * Implements LRU eviction and TTL-based expiration
 *
 * Uses Map's insertion order for LRU tracking (O(1) operations)
 * instead of maintaining a separate array (which was O(n))
 */

import type { SupervisorAgent } from './agent.js';
import { logger } from '../services/logger.js';

/** Maximum number of agents to keep in memory */
const MAX_AGENTS = parseInt(process.env['AGENT_STORE_MAX_AGENTS'] ?? '50', 10);

/** TTL for inactive agents (30 minutes) */
const AGENT_TTL_MS = parseInt(process.env['AGENT_STORE_TTL_MS'] ?? String(30 * 60 * 1000), 10);

/** Cleanup interval (5 minutes) */
const CLEANUP_INTERVAL_MS = parseInt(process.env['AGENT_STORE_CLEANUP_INTERVAL_MS'] ?? String(5 * 60 * 1000), 10);

interface AgentEntry {
  agent: SupervisorAgent;
  lastAccessedAt: number;
  createdAt: number;
}

class AgentStore {
  /**
   * Map preserves insertion order - we use this for LRU tracking
   * Delete + re-add moves an entry to the end (most recently used)
   */
  private agents: Map<string, AgentEntry> = new Map();
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
   * Uses Map's insertion order for LRU - delete + re-add moves to end
   */
  set(runId: string, agent: SupervisorAgent): void {
    const now = Date.now();

    // If already exists, delete first to update insertion order (LRU)
    if (this.agents.has(runId)) {
      this.agents.delete(runId);
    }

    this.agents.set(runId, {
      agent,
      lastAccessedAt: now,
      createdAt: now,
    });

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
   * Uses Map's insertion order - first entries are oldest
   */
  private cleanupOldAgents(): void {
    while (this.agents.size > MAX_AGENTS) {
      // Get the first (oldest) entry from the Map - O(1)
      const firstEntry = this.agents.entries().next();
      if (firstEntry.done) break;

      const [oldestId, entry] = firstEntry.value;
      logger.debug('Evicting agent from store (LRU)', {
        runId: oldestId,
        age: Date.now() - entry.createdAt,
      });
      this.disposeAgent(entry.agent);
      this.agents.delete(oldestId);
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

      // Delete all expired agents - no need for agentOrder array anymore
      for (const runId of expiredIds) {
        const entry = this.agents.get(runId);
        if (entry) {
          this.disposeAgent(entry.agent);
        }
        this.agents.delete(runId);
      }
    }
  }

  /**
   * Get an agent instance (updates LRU order and last accessed time)
   * Uses Map's insertion order - delete + re-add moves to end (O(1))
   */
  get(runId: string): SupervisorAgent | undefined {
    const entry = this.agents.get(runId);
    if (entry) {
      // Update last accessed time
      entry.lastAccessedAt = Date.now();

      // Update LRU order: delete + re-add moves to end (most recently used)
      this.agents.delete(runId);
      this.agents.set(runId, entry);

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
    const entry = this.agents.get(runId);
    if (entry) {
      this.disposeAgent(entry.agent);
    }
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
    // Dispose all agents before clearing
    for (const [runId, entry] of this.agents) {
      logger.debug('Disposing agent during clear', { runId });
      this.disposeAgent(entry.agent);
    }
    this.agents.clear();
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
