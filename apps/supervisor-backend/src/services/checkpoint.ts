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
