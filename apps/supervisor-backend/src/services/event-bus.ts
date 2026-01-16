/**
 * Event Bus for real-time updates
 * Manages WebSocket connections and broadcasts events
 * Persists logs to SQLite database
 */

import { EventEmitter } from 'node:events';
import { db } from './db.js';
import { logger } from './logger.js';

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
  id?: number;  // Database ID for Last-Event-ID support
  runId: string;
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  source: 'supervisor' | 'codex' | 'claude' | 'shell' | 'system';
  message: string;
  metadata?: Record<string, unknown>;
}

// Lazy-initialized prepared statements for run_logs table
// Using functions to ensure statements are created with the current db instance
function getInsertLogStmt() {
  return db.prepare(`
    INSERT INTO run_logs (run_id, timestamp, level, source, message, metadata_json)
    VALUES (@run_id, @timestamp, @level, @source, @message, @metadata_json)
  `);
}

function getGetLogsStmt() {
  return db.prepare(`
    SELECT * FROM run_logs WHERE run_id = ? ORDER BY timestamp ASC
  `);
}

function getGetLogsSinceStmt() {
  return db.prepare(`
    SELECT * FROM run_logs WHERE run_id = ? AND timestamp > ? ORDER BY timestamp ASC
  `);
}

function getGetLogsSinceIdStmt() {
  return db.prepare(`
    SELECT * FROM run_logs WHERE run_id = ? AND id > ? ORDER BY id ASC LIMIT ?
  `);
}

function getGetLogsWithLimitStmt() {
  return db.prepare(`
    SELECT * FROM run_logs WHERE run_id = ? ORDER BY id ASC LIMIT ?
  `);
}

function getDeleteLogsStmt() {
  return db.prepare(`
    DELETE FROM run_logs WHERE run_id = ?
  `);
}

// Get orphaned log sessions (logs exist but no completed/failed run record)
// These are from interrupted runs where server stopped before completion
function getGetOrphanedLogSessionsStmt() {
  return db.prepare(`
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
}

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
  let metadata: Record<string, unknown> | undefined;
  if (row.metadata_json) {
    try {
      metadata = JSON.parse(row.metadata_json);
    } catch {
      // Ignore malformed JSON, log entry still usable without metadata
      logger.error('Failed to parse metadata_json for log', { id: row.id });
    }
  }
  return {
    id: row.id,
    runId: row.run_id,
    timestamp: row.timestamp,
    level: row.level as LogEntry['level'],
    source: row.source as LogEntry['source'],
    message: row.message,
    metadata,
  };
}

/** Buffer cleanup interval (5 minutes) */
const BUFFER_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** Max age for buffer entries (30 minutes) */
const BUFFER_MAX_AGE_MS = 30 * 60 * 1000;

/** Max total entries across all buffers */
const MAX_TOTAL_BUFFER_ENTRIES = 50000;

interface BufferMeta {
  runId: string;
  lastUpdated: number;
  entryCount: number;
}

/** Track listener metadata for automatic cleanup */
interface ListenerMeta {
  runId: string;
  addedAt: number;
  callback: (...args: unknown[]) => void;
}

/** Max listener age before automatic cleanup (10 minutes) */
const LISTENER_MAX_AGE_MS = 10 * 60 * 1000;

class EventBus extends EventEmitter {
  private logBuffer: Map<string, LogEntry[]> = new Map();
  private bufferMeta: Map<string, BufferMeta> = new Map();
  private readonly MAX_BUFFER_SIZE = 1000;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private totalBufferEntries = 0;
  /** Track active listeners for leak detection and cleanup */
  private listenerRegistry: Map<string, ListenerMeta> = new Map();
  private listenerIdCounter = 0;

  constructor() {
    super();
    this.setMaxListeners(100); // Allow many WebSocket connections
    this.startPeriodicCleanup();
  }

  /**
   * Start periodic buffer cleanup
   */
  private startPeriodicCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    this.cleanupTimer = setInterval(() => {
      this.cleanupOldBuffers();
    }, BUFFER_CLEANUP_INTERVAL_MS);

    // Don't prevent Node.js from exiting
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Stop periodic cleanup (for shutdown)
   */
  stopPeriodicCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Clean up old buffer entries and stale listeners based on age
   */
  private cleanupOldBuffers(): void {
    const now = Date.now();
    const expiredRunIds: string[] = [];

    // Find expired buffers
    for (const [runId, meta] of this.bufferMeta) {
      if (now - meta.lastUpdated > BUFFER_MAX_AGE_MS) {
        expiredRunIds.push(runId);
      }
    }

    // Remove expired buffers
    for (const runId of expiredRunIds) {
      const buffer = this.logBuffer.get(runId);
      if (buffer) {
        this.totalBufferEntries -= buffer.length;
      }
      this.logBuffer.delete(runId);
      this.bufferMeta.delete(runId);
    }

    if (expiredRunIds.length > 0) {
      logger.debug('Cleaned up expired log buffers', { count: expiredRunIds.length });
    }

    // If still over total limit, remove oldest buffers
    if (this.totalBufferEntries > MAX_TOTAL_BUFFER_ENTRIES) {
      const sortedMeta = Array.from(this.bufferMeta.entries())
        .sort((a, b) => a[1].lastUpdated - b[1].lastUpdated);

      while (this.totalBufferEntries > MAX_TOTAL_BUFFER_ENTRIES && sortedMeta.length > 0) {
        const [oldestRunId] = sortedMeta.shift()!;
        const buffer = this.logBuffer.get(oldestRunId);
        if (buffer) {
          this.totalBufferEntries -= buffer.length;
        }
        this.logBuffer.delete(oldestRunId);
        this.bufferMeta.delete(oldestRunId);
      }
    }

    // Clean up stale listeners (memory leak prevention)
    this.cleanupStaleListeners(now);
  }

  /**
   * Clean up listeners that have been registered for too long without being removed
   * This prevents memory leaks from disconnected clients
   */
  private cleanupStaleListeners(now: number): void {
    const staleListenerIds: string[] = [];

    for (const [listenerId, meta] of this.listenerRegistry) {
      if (now - meta.addedAt > LISTENER_MAX_AGE_MS) {
        staleListenerIds.push(listenerId);
      }
    }

    for (const listenerId of staleListenerIds) {
      const meta = this.listenerRegistry.get(listenerId);
      if (meta) {
        // Remove the listener from EventEmitter
        this.off(`log:${meta.runId}`, meta.callback);
        this.off(`run:${meta.runId}`, meta.callback);
        this.listenerRegistry.delete(listenerId);
      }
    }

    if (staleListenerIds.length > 0) {
      logger.debug('Cleaned up stale listeners', { count: staleListenerIds.length });
    }
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
   * Returns the database ID for Last-Event-ID support
   */
  addLog(entry: LogEntry): number | undefined {
    let logId: number | undefined;

    // Persist to database first to get ID
    try {
      console.log('[DEBUG] addLog: Inserting log entry', { runId: entry.runId, source: entry.source, message: entry.message.slice(0, 50) });
      const result = getInsertLogStmt().run({
        run_id: entry.runId,
        timestamp: entry.timestamp,
        level: entry.level,
        source: entry.source,
        message: entry.message,
        metadata_json: entry.metadata ? JSON.stringify(entry.metadata) : null,
      });
      logId = Number(result.lastInsertRowid);
      entry.id = logId;
      console.log('[DEBUG] addLog: Log entry inserted successfully', { runId: entry.runId, logId });

      // Verify the log was actually saved
      const verifyStmt = db.prepare('SELECT COUNT(*) as count FROM run_logs WHERE id = ?');
      const verifyResult = verifyStmt.get(logId) as { count: number };
      console.log('[DEBUG] addLog: Verify after insert', { logId, exists: verifyResult.count > 0 });
    } catch (err) {
      console.error('[DEBUG] addLog: FAILED to insert log entry', { runId: entry.runId, error: err instanceof Error ? err.message : String(err) });
      logger.error('Failed to persist log to DB', { error: err instanceof Error ? err.message : String(err) });
    }

    // Buffer logs per run (for real-time streaming)
    let buffer = this.logBuffer.get(entry.runId);
    if (!buffer) {
      buffer = [];
      this.logBuffer.set(entry.runId, buffer);
      this.bufferMeta.set(entry.runId, {
        runId: entry.runId,
        lastUpdated: Date.now(),
        entryCount: 0,
      });
    }

    buffer.push(entry);
    this.totalBufferEntries++;

    // Update metadata
    const meta = this.bufferMeta.get(entry.runId);
    if (meta) {
      meta.lastUpdated = Date.now();
      meta.entryCount = buffer.length;
    }

    // Trim buffer if too large
    if (buffer.length > this.MAX_BUFFER_SIZE) {
      const removedCount = buffer.length - this.MAX_BUFFER_SIZE;
      buffer.splice(0, removedCount);
      this.totalBufferEntries -= removedCount;
    }

    // Emit the log entry (with ID for SSE)
    this.emit('log', entry);
    this.emit(`log:${entry.runId}`, entry);

    return logId;
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
        const rows = getGetLogsSinceStmt().all(runId, since) as LogRow[];
        return rows.map(rowToLogEntry);
      } else {
        const rows = getGetLogsStmt().all(runId) as LogRow[];
        return rows.map(rowToLogEntry);
      }
    } catch (err) {
      logger.error('Failed to load logs from DB', { error: err instanceof Error ? err.message : String(err) });
      return buffer ?? [];
    }
  }

  /**
   * Get logs since a specific event ID (for SSE Last-Event-ID replay)
   */
  getLogsSinceId(runId: string, lastEventId: number, limit = 1000): LogEntry[] {
    try {
      const rows = getGetLogsSinceIdStmt().all(runId, lastEventId, limit) as LogRow[];
      return rows.map(rowToLogEntry);
    } catch (err) {
      logger.error('Failed to load logs since ID', { error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  /**
   * Get recent logs with limit (for initial SSE connection)
   */
  getRecentLogs(runId: string, limit = 100): LogEntry[] {
    // Try buffer first
    const buffer = this.logBuffer.get(runId);
    if (buffer && buffer.length > 0) {
      return buffer.slice(-limit);
    }

    // Load from database
    try {
      const rows = getGetLogsWithLimitStmt().all(runId, limit) as LogRow[];
      return rows.map(rowToLogEntry);
    } catch (err) {
      logger.error('Failed to load recent logs', { error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  /**
   * Clear logs for a run (from memory only, keep in DB for history)
   */
  clearLogs(runId: string): void {
    const buffer = this.logBuffer.get(runId);
    if (buffer) {
      this.totalBufferEntries -= buffer.length;
    }
    this.logBuffer.delete(runId);
    this.bufferMeta.delete(runId);
  }

  /**
   * Delete logs for a run (from both memory and DB)
   */
  deleteLogs(runId: string): void {
    const buffer = this.logBuffer.get(runId);
    if (buffer) {
      this.totalBufferEntries -= buffer.length;
    }
    this.logBuffer.delete(runId);
    this.bufferMeta.delete(runId);
    try {
      getDeleteLogsStmt().run(runId);
    } catch (err) {
      logger.error('Failed to delete logs from DB', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Get buffer statistics for monitoring
   */
  getBufferStats(): {
    totalBuffers: number;
    totalEntries: number;
    oldestBufferAge: number | null;
  } {
    const now = Date.now();
    let oldestAge: number | null = null;

    for (const meta of this.bufferMeta.values()) {
      const age = now - meta.lastUpdated;
      if (oldestAge === null || age > oldestAge) {
        oldestAge = age;
      }
    }

    return {
      totalBuffers: this.logBuffer.size,
      totalEntries: this.totalBufferEntries,
      oldestBufferAge: oldestAge,
    };
  }

  /**
   * Get orphaned log sessions (interrupted runs)
   * These are logs that exist but have no completed run record
   */
  getOrphanedSessions(): OrphanedSession[] {
    try {
      return getGetOrphanedLogSessionsStmt().all() as OrphanedSession[];
    } catch (err) {
      logger.error('Failed to get orphaned sessions', { error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  /**
   * Generate unique listener ID
   */
  private generateListenerId(): string {
    return `listener_${++this.listenerIdCounter}_${Date.now()}`;
  }

  /**
   * Subscribe to run events
   */
  subscribeToRun(runId: string, callback: (event: RunEvent) => void): () => void {
    const listenerId = this.generateListenerId();
    this.listenerRegistry.set(listenerId, {
      runId,
      addedAt: Date.now(),
      callback: callback as (...args: unknown[]) => void,
    });

    this.on(`run:${runId}`, callback);

    return () => {
      this.off(`run:${runId}`, callback);
      this.listenerRegistry.delete(listenerId);
    };
  }

  /**
   * Subscribe to logs for a run
   */
  subscribeToLogs(runId: string, callback: (entry: LogEntry) => void): () => void {
    const listenerId = this.generateListenerId();
    this.listenerRegistry.set(listenerId, {
      runId,
      addedAt: Date.now(),
      callback: callback as (...args: unknown[]) => void,
    });

    this.on(`log:${runId}`, callback);

    return () => {
      this.off(`log:${runId}`, callback);
      this.listenerRegistry.delete(listenerId);
    };
  }

  /**
   * Subscribe to all events
   */
  subscribeToAll(callback: (event: RunEvent | LogEntry) => void): () => void {
    const runHandler = (event: RunEvent) => callback(event);
    const logHandler = (entry: LogEntry) => callback(entry);

    const runListenerId = this.generateListenerId();
    const logListenerId = this.generateListenerId();

    this.listenerRegistry.set(runListenerId, {
      runId: '__all__',
      addedAt: Date.now(),
      callback: runHandler as (...args: unknown[]) => void,
    });
    this.listenerRegistry.set(logListenerId, {
      runId: '__all__',
      addedAt: Date.now(),
      callback: logHandler as (...args: unknown[]) => void,
    });

    this.on('run', runHandler);
    this.on('log', logHandler);

    return () => {
      this.off('run', runHandler);
      this.off('log', logHandler);
      this.listenerRegistry.delete(runListenerId);
      this.listenerRegistry.delete(logListenerId);
    };
  }

  /**
   * Get listener statistics for monitoring
   */
  getListenerStats(): {
    totalListeners: number;
    byRunId: Record<string, number>;
  } {
    const byRunId: Record<string, number> = {};
    for (const meta of this.listenerRegistry.values()) {
      byRunId[meta.runId] = (byRunId[meta.runId] || 0) + 1;
    }
    return {
      totalListeners: this.listenerRegistry.size,
      byRunId,
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
