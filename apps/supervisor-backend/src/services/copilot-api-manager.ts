/**
 * Copilot API Manager
 * Manages the copilot-api proxy process lifecycle
 */

import { spawn, type ChildProcess } from 'child_process';
import { getCopilotAPIConfig, updateSettings } from './settings-store.js';

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

  /**
   * Start the copilot-api proxy
   */
  async start(): Promise<CopilotAPIStatus> {
    if (this.process && this.status.running) {
      console.log('[CopilotAPI] Already running');
      return this.status;
    }

    const config = getCopilotAPIConfig();
    const port = this.extractPort(config.baseUrl);

    console.log(`[CopilotAPI] Config URL: ${config.baseUrl}`);
    console.log(`[CopilotAPI] Starting copilot-api on port ${port}...`);
    console.log(`[CopilotAPI] GitHub token available: ${!!config.githubToken}`);

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

      console.log(`[CopilotAPI] Process spawned with PID: ${this.process.pid}`);

      this.status = {
        running: true,
        pid: this.process.pid,
        url: config.baseUrl,
        startedAt: new Date().toISOString(),
      };

      // Handle stdout
      this.process.stdout?.on('data', (data: Buffer) => {
        const output = data.toString().trim();
        if (output) {
          console.log(`[CopilotAPI] ${output}`);
        }
      });

      // Handle stderr
      this.process.stderr?.on('data', (data: Buffer) => {
        const output = data.toString().trim();
        if (output) {
          console.error(`[CopilotAPI] ${output}`);
        }
      });

      // Handle process exit
      this.process.on('exit', (code, signal) => {
        console.log(`[CopilotAPI] Process exited with code ${code}, signal ${signal}`);
        this.status = { running: false };
        this.process = null;

        // Auto-restart if enabled and didn't exceed max attempts
        if (getCopilotAPIConfig().enabled && this.restartAttempts < this.maxRestartAttempts) {
          this.restartAttempts++;
          console.log(`[CopilotAPI] Attempting restart (${this.restartAttempts}/${this.maxRestartAttempts})...`);
          setTimeout(() => this.start(), 2000);
        }
      });

      this.process.on('error', (err) => {
        console.error(`[CopilotAPI] Process error:`, err);
        this.status = { running: false, error: err.message };
        this.process = null;
      });

      // Wait a bit for the process to start
      await this.waitForReady(config.baseUrl, 10000);

      // Start health check
      this.startHealthCheck();

      // Reset restart attempts on successful start
      this.restartAttempts = 0;

      console.log(`[CopilotAPI] Started successfully on ${config.baseUrl}`);
      return this.status;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[CopilotAPI] Failed to start:`, errorMessage);
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
      console.log('[CopilotAPI] Not running');
      this.status = { running: false };
      return this.status;
    }

    console.log('[CopilotAPI] Stopping...');

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        // Force kill if graceful shutdown didn't work
        if (this.process) {
          console.log('[CopilotAPI] Force killing process...');
          this.process.kill('SIGKILL');
        }
      }, 5000);

      this.process!.on('exit', () => {
        clearTimeout(timeout);
        this.status = { running: false };
        this.process = null;
        console.log('[CopilotAPI] Stopped');
        resolve(this.status);
      });

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
      console.log('[CopilotAPI] Not running, cannot fetch models');
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
        console.warn(`[CopilotAPI] Failed to fetch models: ${response.status}`);
        return [];
      }

      const data = await response.json() as { data?: CopilotModel[] };
      const models = data.data ?? [];
      console.log(`[CopilotAPI] Fetched ${models.length} models`);
      return models;
    } catch (error) {
      console.error('[CopilotAPI] Error fetching models:', error);
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
          console.log('[CopilotAPI] API is responding');
          return;
        }
      } catch {
        // API not ready yet
      }
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    // Don't throw, just warn - the process might still be starting
    console.warn('[CopilotAPI] API not responding yet, but process is running');
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
        console.warn(`[CopilotAPI] Port ${BACKEND_PORT} conflicts with backend, using ${DEFAULT_PORT}`);
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
          console.warn('[CopilotAPI] Health check failed, but process is running');
        } else if (healthy && this.status.error) {
          // Clear error if recovered
          console.log('[CopilotAPI] Health check passed, clearing error');
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
      console.log('[CopilotAPI] Auto-starting (enabled in settings)...');
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
