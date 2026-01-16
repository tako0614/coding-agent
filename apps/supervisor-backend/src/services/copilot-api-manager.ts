/**
 * Copilot API Manager
 * Manages the copilot-api proxy process lifecycle
 */

import { spawn, type ChildProcess } from 'child_process';
import { getCopilotAPIConfig, updateSettings } from './settings-store.js';
import { logger } from './logger.js';

// =============================================================================
// Configuration Constants (configurable via environment variables)
// =============================================================================

/** Restart delay in milliseconds after process exit */
const RESTART_DELAY_MS = parseInt(process.env['COPILOT_API_RESTART_DELAY_MS'] ?? '2000', 10);

/** Force kill timeout in milliseconds */
const FORCE_KILL_TIMEOUT_MS = parseInt(process.env['COPILOT_API_FORCE_KILL_TIMEOUT_MS'] ?? '5000', 10);

/** Fetch models request timeout in milliseconds */
const FETCH_MODELS_TIMEOUT_MS = parseInt(process.env['COPILOT_API_FETCH_MODELS_TIMEOUT_MS'] ?? '5000', 10);

/** Health check /usage endpoint timeout in milliseconds */
const HEALTH_CHECK_USAGE_TIMEOUT_MS = parseInt(process.env['COPILOT_API_HEALTH_USAGE_TIMEOUT_MS'] ?? '3000', 10);

/** Health check /models endpoint timeout in milliseconds */
const HEALTH_CHECK_MODELS_TIMEOUT_MS = parseInt(process.env['COPILOT_API_HEALTH_MODELS_TIMEOUT_MS'] ?? '2000', 10);

/** Wait for ready request timeout in milliseconds */
const WAIT_FOR_READY_REQUEST_TIMEOUT_MS = parseInt(process.env['COPILOT_API_WAIT_READY_TIMEOUT_MS'] ?? '1000', 10);

/** Wait for ready check interval in milliseconds */
const WAIT_FOR_READY_INTERVAL_MS = parseInt(process.env['COPILOT_API_WAIT_READY_INTERVAL_MS'] ?? '500', 10);

/** Health check interval in milliseconds */
const HEALTH_CHECK_INTERVAL_MS = parseInt(process.env['COPILOT_API_HEALTH_CHECK_INTERVAL_MS'] ?? '30000', 10);

/** Health check initial delay in milliseconds */
const HEALTH_CHECK_INITIAL_DELAY_MS = parseInt(process.env['COPILOT_API_HEALTH_CHECK_DELAY_MS'] ?? '10000', 10);

/** Backend port (to avoid conflicts) */
const BACKEND_PORT = parseInt(process.env['BACKEND_PORT'] ?? '3000', 10);

/** Default Copilot API port */
const DEFAULT_COPILOT_API_PORT = parseInt(process.env['COPILOT_API_DEFAULT_PORT'] ?? '4141', 10);

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
          setTimeout(() => this.start(), RESTART_DELAY_MS);
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
      }, FORCE_KILL_TIMEOUT_MS);

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
        signal: AbortSignal.timeout(FETCH_MODELS_TIMEOUT_MS),
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
        signal: AbortSignal.timeout(HEALTH_CHECK_USAGE_TIMEOUT_MS),
      });
      // Any response (even 401/403) means the server is running
      return response.status < 500;
    } catch {
      // Fallback: try to connect to the port
      try {
        const response = await fetch(`${config.baseUrl}/v1/models`, {
          method: 'GET',
          signal: AbortSignal.timeout(HEALTH_CHECK_MODELS_TIMEOUT_MS),
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

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await fetch(`${url}/usage`, {
          method: 'GET',
          signal: AbortSignal.timeout(WAIT_FOR_READY_REQUEST_TIMEOUT_MS),
        });
        // Any response means server is up
        if (response.status < 500) {
          logger.debug('CopilotAPI is responding');
          return;
        }
      } catch {
        // API not ready yet
      }
      await new Promise(resolve => setTimeout(resolve, WAIT_FOR_READY_INTERVAL_MS));
    }

    // Don't throw, just warn - the process might still be starting
    logger.warn('CopilotAPI not responding yet, but process is running');
  }

  /**
   * Extract port from URL (avoid conflicts with backend port)
   */
  private extractPort(url: string): number {
    try {
      const parsed = new URL(url);
      const port = parseInt(parsed.port, 10) || DEFAULT_COPILOT_API_PORT;

      // Don't use the same port as the backend
      if (port === BACKEND_PORT) {
        logger.warn('CopilotAPI port conflicts with backend', { conflictPort: BACKEND_PORT, usingPort: DEFAULT_COPILOT_API_PORT });
        return DEFAULT_COPILOT_API_PORT;
      }

      return port;
    } catch {
      return DEFAULT_COPILOT_API_PORT;
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
      }, HEALTH_CHECK_INTERVAL_MS);
    }, HEALTH_CHECK_INITIAL_DELAY_MS);
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
