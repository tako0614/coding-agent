/**
 * PTY Service - Manages pseudo-terminal sessions
 * Uses node-pty for real terminal emulation
 * Supports session persistence and reconnection
 */

import * as pty from 'node-pty';
import { WebSocket } from 'ws';
import os from 'os';
import { logger } from './logger.js';

// Security limits (configurable via environment variables)
const MAX_INPUT_SIZE = parseInt(process.env['PTY_MAX_INPUT_SIZE'] ?? String(64 * 1024), 10); // 64KB default
const MIN_COLS = 10;
const MAX_COLS = parseInt(process.env['PTY_MAX_COLS'] ?? '500', 10);
const MIN_ROWS = 5;
const MAX_ROWS = parseInt(process.env['PTY_MAX_ROWS'] ?? '200', 10);

// Ring buffer for output storage
class OutputBuffer {
  private buffer: string[] = [];
  private maxSize: number;

  constructor(maxSize: number = 50000) {
    this.maxSize = maxSize;
  }

  append(data: string): void {
    this.buffer.push(data);
    // Trim if exceeds max size
    let totalLength = this.buffer.reduce((sum, s) => sum + s.length, 0);
    while (totalLength > this.maxSize && this.buffer.length > 0) {
      const removed = this.buffer.shift();
      totalLength -= removed?.length || 0;
    }
  }

  getAll(): string {
    return this.buffer.join('');
  }

  clear(): void {
    this.buffer = [];
  }
}

interface PtySession {
  id: string;
  pty: pty.IPty;
  ws: WebSocket | null;  // Can be null when disconnected
  cwd: string;
  shell: string;
  createdAt: Date;
  outputBuffer: OutputBuffer;
  cols: number;
  rows: number;
  exited: boolean;
  exitCode?: number;
  exitSignal?: number;
}

class PtyService {
  private sessions: Map<string, PtySession> = new Map();
  private sessionTimeout = 30 * 60 * 1000; // 30 minutes timeout for orphaned sessions

  /**
   * Get the default shell for the current platform
   */
  private getDefaultShell(): string {
    if (os.platform() === 'win32') {
      // Prefer PowerShell on Windows, fallback to cmd
      return process.env['COMSPEC'] || 'cmd.exe';
    }
    return process.env['SHELL'] || '/bin/bash';
  }

  /**
   * Create a new PTY session
   */
  createSession(ws: WebSocket, options: { cwd?: string; cols?: number; rows?: number } = {}): string {
    const sessionId = `pty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const shell = this.getDefaultShell();
    const cwd = options.cwd || process.cwd();
    // Validate and clamp cols/rows to safe ranges
    const cols = Math.max(MIN_COLS, Math.min(MAX_COLS, Math.floor(options.cols || 80)));
    const rows = Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.floor(options.rows || 24)));

    logger.info('Creating PTY session', { sessionId, shell, cwd });

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: process.env as Record<string, string>,
      useConpty: os.platform() === 'win32', // Use ConPTY on Windows
    });

    const session: PtySession = {
      id: sessionId,
      pty: ptyProcess,
      ws,
      cwd,
      shell,
      createdAt: new Date(),
      outputBuffer: new OutputBuffer(),
      cols,
      rows,
      exited: false,
    };

    this.sessions.set(sessionId, session);

    // Forward PTY output to WebSocket and buffer
    ptyProcess.onData((data: string) => {
      session.outputBuffer.append(data);
      if (session.ws && session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({ type: 'output', data }));
      }
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode, signal }) => {
      logger.info('PTY session exited', { sessionId, exitCode, signal });
      session.exited = true;
      session.exitCode = exitCode;
      session.exitSignal = signal;
      if (session.ws && session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({ type: 'exit', exitCode, signal }));
      }
      // Don't delete session immediately - keep for potential reconnection
      // Schedule cleanup after timeout
      setTimeout(() => {
        const s = this.sessions.get(sessionId);
        if (s && s.exited) {
          this.sessions.delete(sessionId);
          logger.info('Cleaned up exited PTY session', { sessionId });
        }
      }, 60000); // Keep exited sessions for 1 minute
    });

    this.setupWebSocketHandlers(session, ws);

    // Send session info
    ws.send(JSON.stringify({
      type: 'session',
      sessionId,
      shell,
      cwd,
    }));

    return sessionId;
  }

  /**
   * Setup WebSocket handlers for a session
   */
  private setupWebSocketHandlers(session: PtySession, ws: WebSocket): void {
    // Handle WebSocket messages
    ws.on('message', (message: Buffer) => {
      try {
        const msg = JSON.parse(message.toString());
        try {
          this.handleMessage(session.id, msg);
        } catch (handleError) {
          logger.error('Error handling PTY message', {
            sessionId: session.id,
            error: handleError instanceof Error ? handleError.message : String(handleError),
          });
        }
      } catch {
        // Treat as raw input if not JSON (with size validation)
        const rawInput = message.toString();
        if (!session.exited && rawInput.length <= MAX_INPUT_SIZE) {
          session.pty.write(rawInput);
        } else if (rawInput.length > MAX_INPUT_SIZE) {
          logger.warn('PTY raw input rejected: too large', { size: rawInput.length, max: MAX_INPUT_SIZE });
        }
      }
    });

    // Handle WebSocket close - don't destroy session, just detach
    ws.on('close', () => {
      logger.info('PTY WebSocket disconnected (keeping session alive)', { sessionId: session.id });
      session.ws = null;

      // Schedule cleanup for orphaned sessions
      setTimeout(() => {
        const s = this.sessions.get(session.id);
        if (s && s.ws === null && !s.exited) {
          logger.info('Destroying orphaned PTY session', { sessionId: session.id });
          this.destroySession(session.id);
        }
      }, this.sessionTimeout);
    });
  }

  /**
   * Reconnect to an existing session
   */
  reconnectSession(sessionId: string, ws: WebSocket): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      logger.warn('Cannot reconnect - session not found', { sessionId });
      return false;
    }

    logger.info('Reconnecting to PTY session', { sessionId });

    // Close old WebSocket if exists
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      session.ws.close();
    }

    session.ws = ws;
    this.setupWebSocketHandlers(session, ws);

    // Send session info
    ws.send(JSON.stringify({
      type: 'session',
      sessionId: session.id,
      shell: session.shell,
      cwd: session.cwd,
      reconnected: true,
    }));

    // Replay buffered output
    const bufferedOutput = session.outputBuffer.getAll();
    if (bufferedOutput) {
      ws.send(JSON.stringify({ type: 'output', data: bufferedOutput, replayed: true }));
    }

    // If session has exited, send exit info
    if (session.exited) {
      ws.send(JSON.stringify({ type: 'exit', exitCode: session.exitCode, signal: session.exitSignal }));
    }

    return true;
  }

  /**
   * Validate input data size and type
   */
  private validateInput(data: unknown): string | null {
    if (typeof data !== 'string') {
      return null;
    }
    if (data.length > MAX_INPUT_SIZE) {
      logger.warn('PTY input rejected: too large', { size: data.length, max: MAX_INPUT_SIZE });
      return null;
    }
    return data;
  }

  /**
   * Validate resize dimensions
   */
  private validateResizeDimensions(cols: unknown, rows: unknown): { cols: number; rows: number } | null {
    if (typeof cols !== 'number' || typeof rows !== 'number') {
      return null;
    }
    // Clamp to valid range
    const validCols = Math.max(MIN_COLS, Math.min(MAX_COLS, Math.floor(cols)));
    const validRows = Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.floor(rows)));
    return { cols: validCols, rows: validRows };
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(sessionId: string, msg: { type: string; data?: string; cols?: number; rows?: number }) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    switch (msg.type) {
      case 'input': {
        // Validate and write input to PTY
        const validatedInput = this.validateInput(msg.data);
        if (validatedInput !== null && !session.exited) {
          session.pty.write(validatedInput);
        }
        break;
      }

      case 'resize': {
        // Validate and resize PTY
        const validDimensions = this.validateResizeDimensions(msg.cols, msg.rows);
        if (validDimensions && !session.exited) {
          session.pty.resize(validDimensions.cols, validDimensions.rows);
          session.cols = validDimensions.cols;
          session.rows = validDimensions.rows;
          logger.debug('PTY session resized', { sessionId, cols: validDimensions.cols, rows: validDimensions.rows });
        }
        break;
      }

      case 'ping':
        // Respond to ping
        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
          session.ws.send(JSON.stringify({ type: 'pong' }));
        }
        break;
    }
  }

  /**
   * Destroy a PTY session
   */
  destroySession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      logger.debug('Destroying PTY session', { sessionId });
      if (!session.exited) {
        session.pty.kill();
      }
      if (session.ws && session.ws.readyState === WebSocket.OPEN) {
        session.ws.close();
      }
      this.sessions.delete(sessionId);
    }
  }

  /**
   * Check if a session exists
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Get session info
   */
  getSession(sessionId: string): { id: string; cwd: string; shell: string; createdAt: Date; exited: boolean; connected: boolean } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return {
      id: session.id,
      cwd: session.cwd,
      shell: session.shell,
      createdAt: session.createdAt,
      exited: session.exited,
      connected: session.ws !== null && session.ws.readyState === WebSocket.OPEN,
    };
  }

  /**
   * Get all active sessions
   */
  getSessions(): Array<{ id: string; cwd: string; shell: string; createdAt: Date; exited: boolean; connected: boolean }> {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      cwd: s.cwd,
      shell: s.shell,
      createdAt: s.createdAt,
      exited: s.exited,
      connected: s.ws !== null && s.ws.readyState === WebSocket.OPEN,
    }));
  }

  /**
   * Cleanup all sessions
   */
  cleanup(): void {
    logger.info('Cleaning up PTY sessions', { count: this.sessions.size });
    for (const sessionId of this.sessions.keys()) {
      this.destroySession(sessionId);
    }
  }
}

export const ptyService = new PtyService();
