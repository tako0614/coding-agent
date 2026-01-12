/**
 * Event Bus for real-time updates
 * Manages WebSocket connections and broadcasts events
 * Persists logs to SQLite database
 */

import { EventEmitter } from 'node:events';
import { db } from './db.js';

export type EventType =
  | 'run:created'
  | 'run:updated'
  | 'run:completed'
  | 'run:failed'
  | 'log:entry'
  | 'verification:started'
  | 'verification:completed'
  | 'task:dispatched'
  | 'task:completed';

export interface RunEvent {
  type: EventType;
  runId: string;
  timestamp: string;
  data: unknown;
}

export interface LogEntry {
  runId: string;
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  source: 'supervisor' | 'codex' | 'claude' | 'shell' | 'system';
  message: string;
  metadata?: Record<string, unknown>;
}

// Prepared statements for run_logs table
const insertLogStmt = db.prepare(`
  INSERT INTO run_logs (run_id, timestamp, level, source, message, metadata_json)
  VALUES (@run_id, @timestamp, @level, @source, @message, @metadata_json)
`);

const getLogsStmt = db.prepare(`
  SELECT * FROM run_logs WHERE run_id = ? ORDER BY timestamp ASC
`);

const getLogsSinceStmt = db.prepare(`
  SELECT * FROM run_logs WHERE run_id = ? AND timestamp > ? ORDER BY timestamp ASC
`);

const deleteLogsStmt = db.prepare(`
  DELETE FROM run_logs WHERE run_id = ?
`);

// Get orphaned log sessions (logs exist but no completed/failed run record)
// These are from interrupted runs where server stopped before completion
const getOrphanedLogSessionsStmt = db.prepare(`
  SELECT DISTINCT
    rl.run_id,
    MIN(rl.timestamp) as first_log,
    MAX(rl.timestamp) as last_log,
    COUNT(*) as log_count,
    (SELECT message FROM run_logs WHERE run_id = rl.run_id ORDER BY timestamp ASC LIMIT 1) as first_message
  FROM run_logs rl
  LEFT JOIN runs r ON rl.run_id = r.run_id
  WHERE r.run_id IS NULL
  GROUP BY rl.run_id
  ORDER BY last_log DESC
  LIMIT 50
`);

interface OrphanedSession {
  run_id: string;
  first_log: string;
  last_log: string;
  log_count: number;
  first_message: string | null;
}

interface LogRow {
  id: number;
  run_id: string;
  timestamp: string;
  level: string;
  source: string;
  message: string;
  metadata_json: string | null;
}

function rowToLogEntry(row: LogRow): LogEntry {
  return {
    runId: row.run_id,
    timestamp: row.timestamp,
    level: row.level as LogEntry['level'],
    source: row.source as LogEntry['source'],
    message: row.message,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
  };
}

class EventBus extends EventEmitter {
  private logBuffer: Map<string, LogEntry[]> = new Map();
  private readonly MAX_BUFFER_SIZE = 1000;

  constructor() {
    super();
    this.setMaxListeners(100); // Allow many WebSocket connections
  }

  /**
   * Emit a run event
   */
  emitRunEvent(event: RunEvent): void {
    this.emit('run', event);
    this.emit(`run:${event.runId}`, event);
  }

  /**
   * Add a log entry (in-memory and database)
   */
  addLog(entry: LogEntry): void {
    // Buffer logs per run (for real-time streaming)
    let buffer = this.logBuffer.get(entry.runId);
    if (!buffer) {
      buffer = [];
      this.logBuffer.set(entry.runId, buffer);
    }

    buffer.push(entry);

    // Trim buffer if too large
    if (buffer.length > this.MAX_BUFFER_SIZE) {
      buffer.splice(0, buffer.length - this.MAX_BUFFER_SIZE);
    }

    // Persist to database
    try {
      insertLogStmt.run({
        run_id: entry.runId,
        timestamp: entry.timestamp,
        level: entry.level,
        source: entry.source,
        message: entry.message,
        metadata_json: entry.metadata ? JSON.stringify(entry.metadata) : null,
      });
    } catch (err) {
      console.error('[EventBus] Failed to persist log to DB:', err);
    }

    // Emit the log entry
    this.emit('log', entry);
    this.emit(`log:${entry.runId}`, entry);
  }

  /**
   * Get logs for a run (from memory if available, else from DB)
   */
  getLogs(runId: string, since?: string): LogEntry[] {
    // Try in-memory buffer first (for active runs)
    const buffer = this.logBuffer.get(runId);
    if (buffer && buffer.length > 0) {
      if (!since) {
        return buffer;
      }
      const sinceDate = new Date(since);
      return buffer.filter(entry => new Date(entry.timestamp) > sinceDate);
    }

    // Load from database
    try {
      if (since) {
        const rows = getLogsSinceStmt.all(runId, since) as LogRow[];
        return rows.map(rowToLogEntry);
      } else {
        const rows = getLogsStmt.all(runId) as LogRow[];
        return rows.map(rowToLogEntry);
      }
    } catch (err) {
      console.error('[EventBus] Failed to load logs from DB:', err);
      return buffer ?? [];
    }
  }

  /**
   * Clear logs for a run (from memory only, keep in DB for history)
   */
  clearLogs(runId: string): void {
    this.logBuffer.delete(runId);
  }

  /**
   * Delete logs for a run (from both memory and DB)
   */
  deleteLogs(runId: string): void {
    this.logBuffer.delete(runId);
    try {
      deleteLogsStmt.run(runId);
    } catch (err) {
      console.error('[EventBus] Failed to delete logs from DB:', err);
    }
  }

  /**
   * Get orphaned log sessions (interrupted runs)
   * These are logs that exist but have no completed run record
   */
  getOrphanedSessions(): OrphanedSession[] {
    try {
      return getOrphanedLogSessionsStmt.all() as OrphanedSession[];
    } catch (err) {
      console.error('[EventBus] Failed to get orphaned sessions:', err);
      return [];
    }
  }

  /**
   * Subscribe to run events
   */
  subscribeToRun(runId: string, callback: (event: RunEvent) => void): () => void {
    this.on(`run:${runId}`, callback);
    return () => this.off(`run:${runId}`, callback);
  }

  /**
   * Subscribe to logs for a run
   */
  subscribeToLogs(runId: string, callback: (entry: LogEntry) => void): () => void {
    this.on(`log:${runId}`, callback);
    return () => this.off(`log:${runId}`, callback);
  }

  /**
   * Subscribe to all events
   */
  subscribeToAll(callback: (event: RunEvent | LogEntry) => void): () => void {
    const runHandler = (event: RunEvent) => callback(event);
    const logHandler = (entry: LogEntry) => callback(entry);

    this.on('run', runHandler);
    this.on('log', logHandler);

    return () => {
      this.off('run', runHandler);
      this.off('log', logHandler);
    };
  }
}

// Singleton instance
export const eventBus = new EventBus();

/**
 * Helper to log with the event bus
 */
export function log(
  runId: string,
  level: LogEntry['level'],
  source: LogEntry['source'],
  message: string,
  metadata?: Record<string, unknown>
): void {
  eventBus.addLog({
    runId,
    timestamp: new Date().toISOString(),
    level,
    source,
    message,
    metadata,
  });
}
