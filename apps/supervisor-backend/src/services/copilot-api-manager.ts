/**
 * Copilot API Manager
 * Manages the copilot-api proxy process lifecycle
 */

import { spawn, type ChildProcess } from 'child_process';
import { getCopilotAPIConfig, updateSettings } from './settings-store.js';
import { logger } from './logger.js';

export interface CopilotAPIStatus {
  running: boolean;
  pid?: number;
  url?: string;
  error?: string;
  startedAt?: string;
}

export interface CopilotModel {
  id: string;
  object: string;
  created?: number;
  owned_by?: string;
}

class CopilotAPIManager {
  private process: ChildProcess | null = null;
  private status: CopilotAPIStatus = { running: false };
  private restartAttempts = 0;
  private maxRestartAttempts = 3;
  private healthCheckInterval: NodeJS.Timeout | null = null;

  // Store listener references for cleanup
  private stdoutListener: ((data: Buffer) => void) | null = null;
  private stderrListener: ((data: Buffer) => void) | null = null;
  private exitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
  private errorListener: ((err: Error) => void) | null = null;

  /**
   * Clean up process listeners to prevent memory leaks
   */
  private cleanupListeners(): void {
    if (this.process) {
      if (this.stdoutListener && this.process.stdout) {
        this.process.stdout.off('data', this.stdoutListener);
      }
      if (this.stderrListener && this.process.stderr) {
        this.process.stderr.off('data', this.stderrListener);
      }
      if (this.exitListener) {
        this.process.off('exit', this.exitListener);
      }
      if (this.errorListener) {
        this.process.off('error', this.errorListener);
      }
    }
    this.stdoutListener = null;
    this.stderrListener = null;
    this.exitListener = null;
    this.errorListener = null;
  }

  /**
   * Start the copilot-api proxy
   */
  async start(): Promise<CopilotAPIStatus> {
    if (this.process && this.status.running) {
      logger.info('CopilotAPI already running');
      return this.status;
    }

    // Clean up any existing listeners before starting
    this.cleanupListeners();

    const config = getCopilotAPIConfig();
    const port = this.extractPort(config.baseUrl);

    logger.info('Starting copilot-api', { url: config.baseUrl, port, hasToken: !!config.githubToken });

    try {
      // Use npx to run copilot-api (shell: true handles Windows .cmd extensions)
      const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
      this.process = spawn(command, ['copilot-api@latest', 'start', '--port', String(port)], {
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Pass GitHub token if available
          ...(config.githubToken ? { GITHUB_TOKEN: config.githubToken } : {}),
        },
      });

      logger.debug('CopilotAPI process spawned', { pid: this.process.pid });

      this.status = {
        running: true,
        pid: this.process.pid,
        url: config.baseUrl,
        startedAt: new Date().toISOString(),
      };

      // Define listeners as bound functions for cleanup
      this.stdoutListener = (data: Buffer) => {
        const output = data.toString().trim();
        if (output) {
          logger.debug('CopilotAPI stdout', { output });
        }
      };

      this.stderrListener = (data: Buffer) => {
        const output = data.toString().trim();
        if (output) {
          logger.warn('CopilotAPI stderr', { output });
        }
      };

      this.exitListener = (code, signal) => {
        logger.info('CopilotAPI process exited', { code, signal });
        this.cleanupListeners();
        this.status = { running: false };
        this.process = null;

        // Auto-restart if enabled and didn't exceed max attempts
        if (getCopilotAPIConfig().enabled && this.restartAttempts < this.maxRestartAttempts) {
          this.restartAttempts++;
          logger.info('CopilotAPI attempting restart', { attempt: this.restartAttempts, maxAttempts: this.maxRestartAttempts });
          setTimeout(() => this.start(), 2000);
        }
      };

      this.errorListener = (err) => {
        logger.error('CopilotAPI process error', { error: err.message });
        this.status = { running: false, error: err.message };
        this.process = null;
      };

      // Attach listeners
      this.process.stdout?.on('data', this.stdoutListener);
      this.process.stderr?.on('data', this.stderrListener);
      this.process.on('exit', this.exitListener);
      this.process.on('error', this.errorListener);

      // Wait a bit for the process to start
      await this.waitForReady(config.baseUrl, 10000);

      // Start health check
      this.startHealthCheck();

      // Reset restart attempts on successful start
      this.restartAttempts = 0;

      logger.info('CopilotAPI started successfully', { url: config.baseUrl });
      return this.status;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('CopilotAPI failed to start', { error: errorMessage });
      this.status = { running: false, error: errorMessage };
      return this.status;
    }
  }

  /**
   * Stop the copilot-api proxy
   */
  async stop(): Promise<CopilotAPIStatus> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (!this.process) {
      logger.debug('CopilotAPI not running');
      this.status = { running: false };
      return this.status;
    }

    logger.info('CopilotAPI stopping');

    // Clean up existing listeners to avoid memory leaks and duplicate handlers
    this.cleanupListeners();

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        // Force kill if graceful shutdown didn't work
        if (this.process) {
          logger.warn('CopilotAPI force killing process');
          this.process.kill('SIGKILL');
        }
      }, 5000);

      // Create a one-time exit handler for this stop operation
      const stopExitHandler = () => {
        clearTimeout(timeout);
        this.status = { running: false };
        this.process = null;
        logger.info('CopilotAPI stopped');
        resolve(this.status);
      };

      this.process!.once('exit', stopExitHandler);

      // Try graceful shutdown first
      this.process!.kill('SIGTERM');
    });
  }

  /**
   * Get current status
   */
  getStatus(): CopilotAPIStatus {
    return { ...this.status };
  }

  /**
   * Fetch available models from copilot-api
   */
  async fetchModels(): Promise<CopilotModel[]> {
    const config = getCopilotAPIConfig();
    if (!this.status.running) {
      logger.debug('CopilotAPI not running, cannot fetch models');
      return [];
    }

    try {
      const response = await fetch(`${config.baseUrl}/v1/models`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${config.githubToken || 'dummy'}`,
        },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        logger.warn('CopilotAPI failed to fetch models', { status: response.status });
        return [];
      }

      const data = await response.json() as { data?: CopilotModel[] };
      const models = data.data ?? [];
      logger.debug('CopilotAPI fetched models', { count: models.length });
      return models;
    } catch (error) {
      logger.error('CopilotAPI error fetching models', { error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }

  /**
   * Check if the API is healthy
   */
  async checkHealth(): Promise<boolean> {
    const config = getCopilotAPIConfig();
    try {
      // Try /usage endpoint first (doesn't require auth)
      const response = await fetch(`${config.baseUrl}/usage`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      });
      // Any response (even 401/403) means the server is running
      return response.status < 500;
    } catch {
      // Fallback: try to connect to the port
      try {
        const response = await fetch(`${config.baseUrl}/v1/models`, {
          method: 'GET',
          signal: AbortSignal.timeout(2000),
        });
        return response.status < 500;
      } catch {
        return false;
      }
    }
  }

  /**
   * Wait for the API to be ready
   */
  private async waitForReady(url: string, timeoutMs: number): Promise<void> {
    const startTime = Date.now();
    const checkInterval = 500;

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await fetch(`${url}/usage`, {
          method: 'GET',
          signal: AbortSignal.timeout(1000),
        });
        // Any response means server is up
        if (response.status < 500) {
          logger.debug('CopilotAPI is responding');
          return;
        }
      } catch {
        // API not ready yet
      }
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    // Don't throw, just warn - the process might still be starting
    logger.warn('CopilotAPI not responding yet, but process is running');
  }

  /**
   * Extract port from URL (avoid port 3000 which is used by backend)
   */
  private extractPort(url: string): number {
    const BACKEND_PORT = 3000;
    const DEFAULT_PORT = 4141;

    try {
      const parsed = new URL(url);
      const port = parseInt(parsed.port, 10) || DEFAULT_PORT;

      // Don't use the same port as the backend
      if (port === BACKEND_PORT) {
        logger.warn('CopilotAPI port conflicts with backend', { conflictPort: BACKEND_PORT, usingPort: DEFAULT_PORT });
        return DEFAULT_PORT;
      }

      return port;
    } catch {
      return DEFAULT_PORT;
    }
  }

  /**
   * Start periodic health check
   */
  private startHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    // Wait a bit before first health check to allow startup
    setTimeout(() => {
      this.healthCheckInterval = setInterval(async () => {
        if (!this.status.running) return;

        const healthy = await this.checkHealth();
        if (!healthy && this.status.running) {
          // Only warn, don't set error - copilot-api might just be slow
          logger.warn('CopilotAPI health check failed, but process is running');
        } else if (healthy && this.status.error) {
          // Clear error if recovered
          logger.info('CopilotAPI health check passed, clearing error');
          delete this.status.error;
        }
      }, 30000); // Check every 30 seconds
    }, 10000); // Wait 10 seconds before first check
  }

  /**
   * Initialize - auto-start if enabled in settings
   */
  async initialize(): Promise<void> {
    const config = getCopilotAPIConfig();
    if (config.enabled) {
      logger.info('CopilotAPI auto-starting (enabled in settings)');
      await this.start();
    }
  }

  /**
   * Shutdown - cleanup on server shutdown
   */
  async shutdown(): Promise<void> {
    await this.stop();
  }
}

// Singleton instance
export const copilotAPIManager = new CopilotAPIManager();
