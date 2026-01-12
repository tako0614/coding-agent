/**
 * Server Manager - Manages the backend Node.js server lifecycle
 *
 * Handles:
 * - Starting the bundled backend server
 * - Stopping gracefully with timeout
 * - Restarting for updates
 * - Health monitoring
 * - Log forwarding
 */

import { spawn, ChildProcess } from 'child_process';
import { join } from 'path';
import { app } from 'electron';
import log from 'electron-log';

export type ServerStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface ServerManagerOptions {
  port: number;
  onStatusChange?: (status: ServerStatus) => void;
  onError?: (error: string) => void;
  onLog?: (message: string) => void;
}

export interface ServerState {
  running: boolean;
  status: ServerStatus;
  pid?: number;
  port: number;
  startedAt?: string;
  error?: string;
}

export class ServerManager {
  private process: ChildProcess | null = null;
  private status: ServerStatus = 'stopped';
  private port: number;
  private options: ServerManagerOptions;
  private startedAt?: Date;
  private lastError?: string;
  private healthCheckInterval?: NodeJS.Timeout;
  private restartAttempts = 0;
  private maxRestartAttempts = 3;

  constructor(options: ServerManagerOptions) {
    this.options = options;
    this.port = options.port;
  }

  /**
   * Get the path to the backend server
   */
  private getServerPath(): string {
    if (app.isPackaged) {
      // In production, backend is in extraResources
      return join(process.resourcesPath, 'backend', 'server.js');
    } else {
      // In development, use the built backend
      return join(__dirname, '../../../supervisor-backend/dist/server.js');
    }
  }

  /**
   * Get the path to Node.js executable
   */
  private getNodePath(): string {
    if (app.isPackaged) {
      // In production, use bundled Node or system Node
      // For now, use system Node - can bundle Node later
      return process.execPath.includes('electron')
        ? 'node'
        : process.execPath;
    }
    return 'node';
  }

  /**
   * Start the backend server
   */
  async start(): Promise<void> {
    if (this.status === 'running' || this.status === 'starting') {
      log.info('Server already running or starting');
      return;
    }

    this.setStatus('starting');
    log.info('Starting backend server...');

    const serverPath = this.getServerPath();
    const nodePath = this.getNodePath();

    log.info(`Server path: ${serverPath}`);
    log.info(`Node path: ${nodePath}`);

    try {
      this.process = spawn(nodePath, [serverPath], {
        cwd: app.isPackaged
          ? join(process.resourcesPath, 'backend')
          : join(__dirname, '../../../supervisor-backend'),
        env: {
          ...process.env,
          PORT: String(this.port),
          NODE_ENV: app.isPackaged ? 'production' : 'development',
          // Prevent the server from opening a browser
          BROWSER: 'none',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        // On Windows, use shell to handle .cmd extensions
        shell: process.platform === 'win32',
      });

      // Handle stdout
      this.process.stdout?.on('data', (data: Buffer) => {
        const message = data.toString().trim();
        if (message) {
          this.options.onLog?.(message);

          // Detect successful startup
          if (message.includes('Server running') || message.includes(`listening on port ${this.port}`)) {
            this.setStatus('running');
            this.startedAt = new Date();
            this.restartAttempts = 0;
            log.info('Backend server started successfully');
            this.startHealthCheck();
          }
        }
      });

      // Handle stderr
      this.process.stderr?.on('data', (data: Buffer) => {
        const message = data.toString().trim();
        if (message) {
          log.warn(`[Server stderr] ${message}`);
          this.options.onLog?.(message);
        }
      });

      // Handle process exit
      this.process.on('exit', (code, signal) => {
        log.info(`Server process exited with code ${code}, signal ${signal}`);
        this.stopHealthCheck();
        this.process = null;

        if (this.status !== 'stopping') {
          // Unexpected exit
          this.setStatus('error');
          this.lastError = `Server exited unexpectedly (code: ${code})`;
          this.options.onError?.(this.lastError);

          // Auto-restart if not exceeded max attempts
          if (this.restartAttempts < this.maxRestartAttempts) {
            this.restartAttempts++;
            log.info(`Auto-restarting server (attempt ${this.restartAttempts}/${this.maxRestartAttempts})`);
            setTimeout(() => this.start(), 2000);
          }
        } else {
          this.setStatus('stopped');
        }
      });

      // Handle process error
      this.process.on('error', (error) => {
        log.error('Server process error:', error);
        this.setStatus('error');
        this.lastError = error.message;
        this.options.onError?.(error.message);
      });

      // Wait for server to be ready
      await this.waitForReady();

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to start server:', message);
      this.setStatus('error');
      this.lastError = message;
      this.options.onError?.(message);
      throw error;
    }
  }

  /**
   * Wait for the server to be ready
   */
  private async waitForReady(timeoutMs = 30000): Promise<void> {
    const startTime = Date.now();
    const checkInterval = 500;

    while (Date.now() - startTime < timeoutMs) {
      if (this.status === 'running') {
        return;
      }

      if (this.status === 'error') {
        throw new Error(this.lastError || 'Server failed to start');
      }

      // Try to connect to the server
      try {
        const response = await fetch(`http://localhost:${this.port}/api/health`, {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) {
          this.setStatus('running');
          this.startedAt = new Date();
          return;
        }
      } catch {
        // Server not ready yet
      }

      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    // Don't throw - server might still be starting
    log.warn('Server startup timeout, but process is still running');
  }

  /**
   * Stop the backend server
   */
  async stop(): Promise<void> {
    if (this.status === 'stopped' || this.status === 'stopping') {
      return;
    }

    this.setStatus('stopping');
    this.stopHealthCheck();
    log.info('Stopping backend server...');

    if (!this.process) {
      this.setStatus('stopped');
      return;
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        // Force kill if graceful shutdown didn't work
        if (this.process) {
          log.warn('Force killing server process');
          this.process.kill('SIGKILL');
        }
      }, 10000);

      const cleanup = () => {
        clearTimeout(timeout);
        this.process = null;
        this.setStatus('stopped');
        log.info('Backend server stopped');
        resolve();
      };

      this.process!.once('exit', cleanup);

      // Try graceful shutdown first
      if (process.platform === 'win32') {
        this.process!.kill(); // SIGTERM not supported on Windows
      } else {
        this.process!.kill('SIGTERM');
      }
    });
  }

  /**
   * Restart the backend server
   */
  async restart(): Promise<void> {
    log.info('Restarting backend server...');
    await this.stop();
    await this.start();
  }

  /**
   * Get current server state
   */
  getStatus(): ServerState {
    return {
      running: this.status === 'running',
      status: this.status,
      pid: this.process?.pid,
      port: this.port,
      startedAt: this.startedAt?.toISOString(),
      error: this.lastError,
    };
  }

  /**
   * Check if server is healthy
   */
  async checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(`http://localhost:${this.port}/api/health`, {
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Start periodic health checks
   */
  private startHealthCheck(): void {
    this.stopHealthCheck();

    this.healthCheckInterval = setInterval(async () => {
      if (this.status !== 'running') return;

      const healthy = await this.checkHealth();
      if (!healthy) {
        log.warn('Server health check failed');
        // Don't auto-restart on health check failure - might be temporary
      }
    }, 30000); // Check every 30 seconds
  }

  /**
   * Stop health checks
   */
  private stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }
  }

  /**
   * Update status and notify listeners
   */
  private setStatus(status: ServerStatus): void {
    this.status = status;
    this.options.onStatusChange?.(status);
  }
}
