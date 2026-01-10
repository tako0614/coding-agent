/**
 * PTY Service - Manages pseudo-terminal sessions
 * Uses node-pty for real terminal emulation
 */

import * as pty from 'node-pty';
import { WebSocket } from 'ws';
import os from 'os';

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

    console.log(`[PTY] Creating session ${sessionId} with shell: ${shell}, cwd: ${cwd}`);

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
      console.log(`[PTY] Session ${sessionId} exited with code ${exitCode}, signal ${signal}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exit', exitCode, signal }));
      }
      this.sessions.delete(sessionId);
    });

    // Handle WebSocket messages
    ws.on('message', (message: Buffer) => {
      try {
        const msg = JSON.parse(message.toString());
        this.handleMessage(sessionId, msg);
      } catch {
        // Treat as raw input if not JSON
        ptyProcess.write(message.toString());
      }
    });

    // Handle WebSocket close
    ws.on('close', () => {
      console.log(`[PTY] WebSocket closed for session ${sessionId}`);
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
          console.log(`[PTY] Resized session ${sessionId} to ${msg.cols}x${msg.rows}`);
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
      console.log(`[PTY] Destroying session ${sessionId}`);
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
    console.log(`[PTY] Cleaning up ${this.sessions.size} sessions`);
    for (const sessionId of this.sessions.keys()) {
      this.destroySession(sessionId);
    }
  }
}

export const ptyService = new PtyService();
