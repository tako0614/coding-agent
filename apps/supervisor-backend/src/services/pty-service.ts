/**
 * PTY Service - Manages pseudo-terminal sessions
 * Uses node-pty for real terminal emulation
 */

import * as pty from 'node-pty';
import { WebSocket } from 'ws';
import os from 'os';
import { logger } from './logger.js';

interface PtySession {
  id: string;
  pty: pty.IPty;
  ws: WebSocket;
  cwd: string;
  createdAt: Date;
}

class PtyService {
  private sessions: Map<string, PtySession> = new Map();

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

    logger.info('Creating PTY session', { sessionId, shell, cwd });

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: options.cols || 80,
      rows: options.rows || 24,
      cwd,
      env: process.env as Record<string, string>,
      useConpty: os.platform() === 'win32', // Use ConPTY on Windows
    });

    const session: PtySession = {
      id: sessionId,
      pty: ptyProcess,
      ws,
      cwd,
      createdAt: new Date(),
    };

    this.sessions.set(sessionId, session);

    // Forward PTY output to WebSocket
    ptyProcess.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'output', data }));
      }
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode, signal }) => {
      logger.info('PTY session exited', { sessionId, exitCode, signal });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exit', exitCode, signal }));
      }
      this.sessions.delete(sessionId);
    });

    // Handle WebSocket messages
    ws.on('message', (message: Buffer) => {
      try {
        const msg = JSON.parse(message.toString());
        try {
          this.handleMessage(sessionId, msg);
        } catch (handleError) {
          logger.error('Error handling PTY message', {
            sessionId,
            error: handleError instanceof Error ? handleError.message : String(handleError),
          });
        }
      } catch {
        // Treat as raw input if not JSON
        ptyProcess.write(message.toString());
      }
    });

    // Handle WebSocket close
    ws.on('close', () => {
      logger.info('PTY WebSocket closed', { sessionId });
      this.destroySession(sessionId);
    });

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
   * Handle incoming WebSocket messages
   */
  private handleMessage(sessionId: string, msg: { type: string; data?: string; cols?: number; rows?: number }) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    switch (msg.type) {
      case 'input':
        // Write input to PTY
        if (msg.data) {
          session.pty.write(msg.data);
        }
        break;

      case 'resize':
        // Resize PTY
        if (msg.cols && msg.rows) {
          session.pty.resize(msg.cols, msg.rows);
          logger.debug('PTY session resized', { sessionId, cols: msg.cols, rows: msg.rows });
        }
        break;

      case 'ping':
        // Respond to ping
        if (session.ws.readyState === WebSocket.OPEN) {
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
      session.pty.kill();
      this.sessions.delete(sessionId);
    }
  }

  /**
   * Get all active sessions
   */
  getSessions(): Array<{ id: string; cwd: string; createdAt: Date }> {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      cwd: s.cwd,
      createdAt: s.createdAt,
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
