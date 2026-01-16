/**
 * Model Router Service
 * Routes requests to appropriate models based on usage and availability
 */

import { createCopilotProvider, type CopilotProvider, type UsageInfo } from '@supervisor/provider-copilot';
import { logger } from './logger.js';

export interface ModelRouterConfig {
  /** Copilot API base URL */
  copilotBaseUrl?: string;
  /** Premium model threshold (0-1) */
  usageThreshold?: number;
  /** Models configuration */
  models?: {
    premium: string;
    standard: string;
    fallback: string;
  };
  /** Enable Copilot integration */
  enableCopilot?: boolean;
}

export interface ModelSelection {
  model: string;
  provider: 'copilot' | 'claude' | 'codex' | 'local';
  reason: string;
}

export class ModelRouterService {
  private copilotProvider?: CopilotProvider;
  private config: Required<ModelRouterConfig>;
  private cachedUsage?: UsageInfo;
  private usageCacheTime: number = 0;
  private readonly CACHE_TTL_MS = 60000; // 1 minute

  constructor(config: ModelRouterConfig = {}) {
    this.config = {
      copilotBaseUrl: config.copilotBaseUrl ?? 'http://localhost:4141',
      usageThreshold: config.usageThreshold ?? 0.8,
      models: config.models ?? {
        premium: 'gpt-4',
        standard: 'gpt-3.5-turbo',
        fallback: 'gpt-3.5-turbo',
      },
      enableCopilot: config.enableCopilot ?? false,
    };

    if (this.config.enableCopilot) {
      this.copilotProvider = createCopilotProvider({
        baseUrl: this.config.copilotBaseUrl,
      });
    }
  }

  /**
   * Get cached or fresh usage info
   */
  private async getUsage(): Promise<UsageInfo | null> {
    if (!this.copilotProvider) return null;

    const now = Date.now();
    if (this.cachedUsage && now - this.usageCacheTime < this.CACHE_TTL_MS) {
      return this.cachedUsage;
    }

    try {
      this.cachedUsage = await this.copilotProvider.getUsage();
      this.usageCacheTime = now;
      return this.cachedUsage;
    } catch (error) {
      logger.warn('Failed to get usage', { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  /**
   * Select the best model for a given task
   */
  async selectModel(taskType: 'supervisor' | 'executor'): Promise<ModelSelection> {
    // If Copilot is not enabled, use local routing
    if (!this.config.enableCopilot || !this.copilotProvider) {
      return {
        model: taskType === 'supervisor' ? 'claude-sonnet-4-20250514' : 'gpt-4.1',
        provider: taskType === 'supervisor' ? 'claude' : 'codex',
        reason: 'Copilot integration disabled',
      };
    }

    const usage = await this.getUsage();

    if (!usage) {
      return {
        model: this.config.models.fallback,
        provider: 'copilot',
        reason: 'Could not fetch usage, using fallback',
      };
    }

    const usageRatio = usage.premium_requests.used / usage.premium_requests.limit;

    if (usageRatio >= this.config.usageThreshold) {
      return {
        model: this.config.models.standard,
        provider: 'copilot',
        reason: `Usage at ${(usageRatio * 100).toFixed(1)}%, using standard model`,
      };
    }

    return {
      model: this.config.models.premium,
      provider: 'copilot',
      reason: `Usage at ${(usageRatio * 100).toFixed(1)}%, using premium model`,
    };
  }

  /**
   * Get current usage statistics
   */
  async getUsageStats(): Promise<{
    available: boolean;
    usage?: UsageInfo;
    recommendation: string;
  }> {
    if (!this.copilotProvider) {
      return {
        available: false,
        recommendation: 'Copilot integration not enabled',
      };
    }

    const usage = await this.getUsage();

    if (!usage) {
      return {
        available: false,
        recommendation: 'Could not fetch usage information',
      };
    }

    const ratio = usage.premium_requests.used / usage.premium_requests.limit;
    let recommendation: string;

    if (ratio < 0.5) {
      recommendation = 'Usage is low, premium models available';
    } else if (ratio < 0.8) {
      recommendation = 'Usage is moderate, consider batching requests';
    } else if (ratio < 0.95) {
      recommendation = 'Usage is high, switching to standard models';
    } else {
      recommendation = 'Usage limit nearly reached, fallback mode active';
    }

    return {
      available: true,
      usage,
      recommendation,
    };
  }

  /**
   * Check if Copilot provider is available
   */
  async checkCopilotAvailability(): Promise<boolean> {
    if (!this.copilotProvider) return false;

    try {
      await this.copilotProvider.getUsage();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the Copilot provider (if enabled)
   */
  getCopilotProvider(): CopilotProvider | undefined {
    return this.copilotProvider;
  }
}

// Singleton instance
let modelRouterInstance: ModelRouterService | null = null;

export function getModelRouter(config?: ModelRouterConfig): ModelRouterService {
  if (!modelRouterInstance) {
    modelRouterInstance = new ModelRouterService(config);
  }
  return modelRouterInstance;
}

export function resetModelRouter(): void {
  modelRouterInstance = null;
}
