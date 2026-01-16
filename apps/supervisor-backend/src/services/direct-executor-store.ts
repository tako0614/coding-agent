/**
 * Direct Executor Store
 * Manages sessions for direct Claude Code / Codex execution
 *
 * SECURITY: Validates all file paths to prevent directory traversal attacks.
 */

import { v4 as uuidv4 } from 'uuid';
import { ClaudeAdapter, createClaudeAdapter } from '@supervisor/executor-claude';
import { CodexAdapter, createCodexAdapter } from '@supervisor/executor-codex';
import { validateRepoPath, PathSecurityError } from './path-sandbox.js';
import { logger } from './logger.js';

export type DirectExecutorType = 'claude' | 'codex';

export interface DirectExecutorSession {
  session_id: string;
  executor_type: DirectExecutorType;
  cwd: string;
  claude_session_id?: string;
  codex_thread_id?: string;
  created_at: string;
  last_activity: string;
}

interface SessionEntry {
  session: DirectExecutorSession;
  claudeAdapter?: ClaudeAdapter;
  codexAdapter?: CodexAdapter;
}

const MAX_SESSIONS = parseInt(process.env['DIRECT_EXECUTOR_MAX_SESSIONS'] ?? '20', 10);
const SESSION_TTL_MS = parseInt(process.env['DIRECT_EXECUTOR_TTL_MS'] ?? String(30 * 60 * 1000), 10); // 30 minutes default
const CLEANUP_INTERVAL_MS = parseInt(process.env['DIRECT_EXECUTOR_CLEANUP_INTERVAL_MS'] ?? String(5 * 60 * 1000), 10); // 5 minutes default

class DirectExecutorStore {
  private sessions: Map<string, SessionEntry> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.startCleanup();
  }

  /**
   * Create a new executor session
   * @throws PathSecurityError if cwd is invalid or points to protected directories
   */
  create(executorType: DirectExecutorType, cwd: string): DirectExecutorSession {
    // Validate cwd to prevent path traversal attacks
    let validatedCwd: string;
    try {
      validatedCwd = validateRepoPath(cwd);
    } catch (error) {
      if (error instanceof PathSecurityError) {
        logger.warn('Direct executor session rejected: invalid cwd', {
          cwd,
          error: error.message,
        });
        throw error;
      }
      throw new PathSecurityError('Invalid working directory', cwd, '');
    }

    // Evict oldest session if at capacity
    if (this.sessions.size >= MAX_SESSIONS) {
      this.evictOldest();
    }

    const now = new Date().toISOString();
    const session: DirectExecutorSession = {
      session_id: uuidv4(),
      executor_type: executorType,
      cwd: validatedCwd,
      created_at: now,
      last_activity: now,
    };

    const entry: SessionEntry = { session };

    // Create appropriate adapter
    if (executorType === 'claude') {
      entry.claudeAdapter = createClaudeAdapter({
        maxTurns: 100,
        permissionMode: 'acceptEdits',
      });
    } else {
      entry.codexAdapter = createCodexAdapter({
        sandbox: true,
      });
    }

    this.sessions.set(session.session_id, entry);
    return session;
  }

  /**
   * Get a session by ID
   */
  get(sessionId: string): SessionEntry | undefined {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      // Update last activity
      entry.session.last_activity = new Date().toISOString();
    }
    return entry;
  }

  /**
   * Get session info only (without adapters)
   */
  getSession(sessionId: string): DirectExecutorSession | undefined {
    return this.get(sessionId)?.session;
  }

  /**
   * List all sessions
   */
  list(): DirectExecutorSession[] {
    return Array.from(this.sessions.values())
      .map(entry => entry.session)
      .sort((a, b) => new Date(b.last_activity).getTime() - new Date(a.last_activity).getTime());
  }

  /**
   * Update session internal IDs
   */
  updateSessionIds(sessionId: string, updates: { claude_session_id?: string; codex_thread_id?: string }): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      if (updates.claude_session_id !== undefined) {
        entry.session.claude_session_id = updates.claude_session_id;
      }
      if (updates.codex_thread_id !== undefined) {
        entry.session.codex_thread_id = updates.codex_thread_id;
      }
      entry.session.last_activity = new Date().toISOString();
    }
  }

  /**
   * Delete a session
   */
  delete(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      // Dispose adapters
      entry.claudeAdapter?.dispose();
      entry.codexAdapter?.dispose();
      this.sessions.delete(sessionId);
      return true;
    }
    return false;
  }

  /**
   * Get Claude adapter for a session
   */
  getClaudeAdapter(sessionId: string): ClaudeAdapter | undefined {
    return this.get(sessionId)?.claudeAdapter;
  }

  /**
   * Get Codex adapter for a session
   */
  getCodexAdapter(sessionId: string): CodexAdapter | undefined {
    return this.get(sessionId)?.codexAdapter;
  }

  /**
   * Evict the oldest session
   */
  private evictOldest(): void {
    let oldestId: string | null = null;
    let oldestTime = Infinity;

    for (const [id, entry] of this.sessions) {
      const time = new Date(entry.session.last_activity).getTime();
      if (time < oldestTime) {
        oldestTime = time;
        oldestId = id;
      }
    }

    if (oldestId) {
      this.delete(oldestId);
    }
  }

  /**
   * Clean up expired sessions
   */
  private cleanup(): void {
    const now = Date.now();
    const expiredIds: string[] = [];

    for (const [id, entry] of this.sessions) {
      const lastActivity = new Date(entry.session.last_activity).getTime();
      if (now - lastActivity > SESSION_TTL_MS) {
        expiredIds.push(id);
      }
    }

    for (const id of expiredIds) {
      this.delete(id);
    }
  }

  /**
   * Start periodic cleanup
   */
  private startCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  /**
   * Stop cleanup and dispose all sessions
   */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    for (const [id] of this.sessions) {
      this.delete(id);
    }
  }
}

// Singleton instance
export const directExecutorStore = new DirectExecutorStore();
