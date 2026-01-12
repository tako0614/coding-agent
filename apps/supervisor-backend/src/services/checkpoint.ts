/**
 * Checkpoint Service
 * Provides state persistence and recovery for long-running tasks
 */

import { db } from './db.js';
import { logger } from './logger.js';

export interface Checkpoint<T = unknown> {
  id: number;
  run_id: string;
  node_name: string;
  state: T;
  created_at: string;
}

/**
 * Save a checkpoint for a run at a specific node
 */
export function saveCheckpoint<T>(
  runId: string,
  nodeName: string,
  state: T
): number {
  const now = new Date().toISOString();
  const stateJson = JSON.stringify(state);

  try {
    const result = db.prepare(`
      INSERT INTO checkpoints (run_id, node_name, state_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(runId, nodeName, stateJson, now);

    const checkpointId = Number(result.lastInsertRowid);

    logger.debug('Checkpoint saved', {
      runId,
      nodeName,
      checkpointId,
      stateSize: stateJson.length,
    });

    return checkpointId;
  } catch (error) {
    logger.error('Failed to save checkpoint', {
      runId,
      nodeName,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Get the latest checkpoint for a run
 */
export function getLatestCheckpoint<T>(runId: string): Checkpoint<T> | null {
  try {
    const row = db.prepare(`
      SELECT id, run_id, node_name, state_json, created_at
      FROM checkpoints
      WHERE run_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(runId) as { id: number; run_id: string; node_name: string; state_json: string; created_at: string } | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      run_id: row.run_id,
      node_name: row.node_name,
      state: JSON.parse(row.state_json) as T,
      created_at: row.created_at,
    };
  } catch (error) {
    logger.error('Failed to get checkpoint', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Get checkpoint at a specific node for a run
 */
export function getCheckpointAtNode<T>(
  runId: string,
  nodeName: string
): Checkpoint<T> | null {
  try {
    const row = db.prepare(`
      SELECT id, run_id, node_name, state_json, created_at
      FROM checkpoints
      WHERE run_id = ? AND node_name = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(runId, nodeName) as { id: number; run_id: string; node_name: string; state_json: string; created_at: string } | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      run_id: row.run_id,
      node_name: row.node_name,
      state: JSON.parse(row.state_json) as T,
      created_at: row.created_at,
    };
  } catch (error) {
    logger.error('Failed to get checkpoint at node', {
      runId,
      nodeName,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Get all checkpoints for a run (for debugging/visualization)
 */
export function getCheckpointHistory(runId: string): Array<Omit<Checkpoint, 'state'> & { state_size: number }> {
  try {
    const rows = db.prepare(`
      SELECT id, run_id, node_name, LENGTH(state_json) as state_size, created_at
      FROM checkpoints
      WHERE run_id = ?
      ORDER BY created_at ASC
    `).all(runId) as Array<{ id: number; run_id: string; node_name: string; state_size: number; created_at: string }>;

    return rows.map(row => ({
      id: row.id,
      run_id: row.run_id,
      node_name: row.node_name,
      state_size: row.state_size,
      created_at: row.created_at,
    }));
  } catch (error) {
    logger.error('Failed to get checkpoint history', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Delete old checkpoints for a run, keeping only the most recent N
 */
export function pruneCheckpoints(runId: string, keepCount = 5): number {
  try {
    // Get IDs to keep
    const keepIds = db.prepare(`
      SELECT id FROM checkpoints
      WHERE run_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(runId, keepCount) as Array<{ id: number }>;

    if (keepIds.length === 0) {
      return 0;
    }

    const keepIdSet = new Set(keepIds.map(r => r.id));

    // Delete old checkpoints
    const result = db.prepare(`
      DELETE FROM checkpoints
      WHERE run_id = ? AND id NOT IN (${keepIds.map(r => r.id).join(',')})
    `).run(runId);

    const deletedCount = result.changes;

    if (deletedCount > 0) {
      logger.debug('Pruned old checkpoints', {
        runId,
        deletedCount,
        keptCount: keepIds.length,
      });
    }

    return deletedCount;
  } catch (error) {
    logger.error('Failed to prune checkpoints', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

/**
 * Delete all checkpoints for a run
 */
export function deleteCheckpoints(runId: string): number {
  try {
    const result = db.prepare(`
      DELETE FROM checkpoints WHERE run_id = ?
    `).run(runId);

    logger.debug('Deleted all checkpoints', {
      runId,
      deletedCount: result.changes,
    });

    return result.changes;
  } catch (error) {
    logger.error('Failed to delete checkpoints', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

/**
 * Check if a run has any checkpoints
 */
export function hasCheckpoints(runId: string): boolean {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) as count FROM checkpoints WHERE run_id = ?
    `).get(runId) as { count: number };

    return row.count > 0;
  } catch {
    return false;
  }
}

/**
 * Create a checkpoint-enabled wrapper for a graph node
 * Automatically saves state after node execution
 */
export function withCheckpoint<TState, TResult extends Partial<TState>>(
  nodeName: string,
  nodeFunction: (state: TState) => Promise<TResult>
): (state: TState) => Promise<TResult> {
  return async (state: TState): Promise<TResult> => {
    // Execute the node
    const result = await nodeFunction(state);

    // Save checkpoint with merged state
    const runId = (state as Record<string, unknown>)['run_id'] as string | undefined;
    if (runId) {
      const mergedState = { ...state, ...result };
      saveCheckpoint(runId, nodeName, mergedState);
      pruneCheckpoints(runId, 10); // Keep last 10 checkpoints
    }

    return result;
  };
}

// =============================================================================
// Interrupted Run Detection
// =============================================================================

interface InterruptedRunInfo {
  run_id: string;
  node_name: string;
  state_json: string;
  created_at: string;
}

/**
 * Detect interrupted runs on startup
 * These are runs with checkpoints but no final_report or error in runs table
 */
export function detectInterruptedRuns(): string[] {
  try {
    // Find checkpoints for runs that haven't completed
    const rows = db.prepare(`
      SELECT DISTINCT c.run_id, c.node_name, c.state_json, c.created_at
      FROM checkpoints c
      INNER JOIN runs r ON c.run_id = r.run_id
      WHERE r.final_report IS NULL
        AND (r.error IS NULL OR r.error = '')
      ORDER BY c.created_at DESC
    `).all() as InterruptedRunInfo[];

    const interruptedIds: string[] = [];
    const now = new Date().toISOString();

    // Group by run_id and get the latest checkpoint
    const latestByRun = new Map<string, InterruptedRunInfo>();
    for (const row of rows) {
      if (!latestByRun.has(row.run_id)) {
        latestByRun.set(row.run_id, row);
      }
    }

    // Mark runs as interrupted
    const markStmt = db.prepare(`
      UPDATE runs SET
        error = ?,
        updated_at = ?
      WHERE run_id = ? AND final_report IS NULL AND (error IS NULL OR error = '')
    `);

    for (const [runId, info] of latestByRun) {
      try {
        const errorMsg = `Run interrupted (server restart). Last checkpoint at phase: ${info.node_name}`;
        markStmt.run(errorMsg, now, runId);
        interruptedIds.push(runId);

        logger.warn('Detected interrupted run', {
          runId,
          lastPhase: info.node_name,
          lastCheckpoint: info.created_at,
        });
      } catch (err) {
        logger.error('Failed to mark run as interrupted', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (interruptedIds.length > 0) {
      logger.info('Interrupted runs detected on startup', {
        count: interruptedIds.length,
        runIds: interruptedIds,
      });
    }

    return interruptedIds;
  } catch (err) {
    logger.error('Failed to detect interrupted runs', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// =============================================================================
// Checkpoint Manager (for periodic checkpointing)
// =============================================================================

/**
 * Checkpoint manager for automatic periodic checkpointing
 */
export class CheckpointManager {
  private runId: string;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentState: Record<string, unknown> | null = null;
  private currentPhase: string = 'unknown';

  constructor(runId: string, intervalMs = 30_000) {
    this.runId = runId;
    this.intervalMs = intervalMs;
  }

  /**
   * Start automatic checkpointing
   */
  start(initialState: Record<string, unknown>, phase: string): void {
    this.currentState = initialState;
    this.currentPhase = phase;

    // Save initial checkpoint
    saveCheckpoint(this.runId, phase, initialState);

    // Start periodic saving
    this.timer = setInterval(() => {
      if (this.currentState) {
        saveCheckpoint(this.runId, this.currentPhase, this.currentState);
        pruneCheckpoints(this.runId, 5); // Keep only last 5 checkpoints
      }
    }, this.intervalMs);

    logger.debug('Checkpoint manager started', {
      runId: this.runId,
      intervalMs: this.intervalMs,
    });
  }

  /**
   * Update state (will be saved on next interval)
   */
  update(state: Record<string, unknown>, phase?: string): void {
    this.currentState = state;
    if (phase) {
      this.currentPhase = phase;
    }
  }

  /**
   * Force immediate checkpoint save
   */
  saveNow(): void {
    if (this.currentState) {
      saveCheckpoint(this.runId, this.currentPhase, this.currentState);
    }
  }

  /**
   * Stop checkpointing
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Save final checkpoint
    if (this.currentState) {
      saveCheckpoint(this.runId, this.currentPhase, this.currentState);
    }

    logger.debug('Checkpoint manager stopped', { runId: this.runId });
  }

  /**
   * Clean up all checkpoints (call after successful completion)
   */
  cleanup(): void {
    this.stop();
    deleteCheckpoints(this.runId);
  }
}

// Store of active checkpoint managers
const checkpointManagers = new Map<string, CheckpointManager>();

/**
 * Get or create a checkpoint manager for a run
 */
export function getCheckpointManager(runId: string, intervalMs = 30_000): CheckpointManager {
  let manager = checkpointManagers.get(runId);
  if (!manager) {
    manager = new CheckpointManager(runId, intervalMs);
    checkpointManagers.set(runId, manager);
  }
  return manager;
}

/**
 * Remove checkpoint manager
 */
export function removeCheckpointManager(runId: string): void {
  const manager = checkpointManagers.get(runId);
  if (manager) {
    manager.stop();
    checkpointManagers.delete(runId);
  }
}

/**
 * Stop all checkpoint managers (call on shutdown)
 */
export function stopAllCheckpointManagers(): void {
  for (const manager of checkpointManagers.values()) {
    manager.stop();
  }
  checkpointManagers.clear();
  logger.info('All checkpoint managers stopped');
}
