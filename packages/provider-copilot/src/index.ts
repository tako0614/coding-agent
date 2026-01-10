/**
 * @supervisor/provider-copilot
 * GitHub Copilot API provider for Supervisor Agent
 *
 * Uses ericc-ch/copilot-api as a proxy to access Copilot's OpenAI-compatible API
 */

import OpenAI from 'openai';

export interface CopilotProviderConfig {
  /** Base URL for the copilot-api proxy (default: http://localhost:4141) */
  baseUrl?: string;
  /** API key (usually from Copilot authentication) */
  apiKey?: string;
}

export interface UsageInfo {
  premium_requests: {
    used: number;
    limit: number;
    reset_at: string;
  };
  embeddings?: {
    used: number;
    limit: number;
  };
}

export interface ModelInfo {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

export class CopilotProvider {
  private client: OpenAI;
  private baseUrl: string;

  constructor(config: CopilotProviderConfig = {}) {
    this.baseUrl = config.baseUrl ?? 'http://localhost:4141';

    this.client = new OpenAI({
      baseURL: `${this.baseUrl}/v1`,
      apiKey: config.apiKey ?? 'copilot-proxy',
    });
  }

  /**
   * Get current usage information
   */
  async getUsage(): Promise<UsageInfo> {
    const response = await fetch(`${this.baseUrl}/usage`);
    if (!response.ok) {
      throw new Error(`Failed to get usage: ${response.statusText}`);
    }
    return response.json() as Promise<UsageInfo>;
  }

  /**
   * List available models
   */
  async listModels(): Promise<ModelInfo[]> {
    const response = await this.client.models.list();
    return response.data as ModelInfo[];
  }

  /**
   * Check if we're approaching usage limits
   */
  async isNearLimit(threshold: number = 0.8): Promise<boolean> {
    const usage = await this.getUsage();
    const ratio = usage.premium_requests.used / usage.premium_requests.limit;
    return ratio >= threshold;
  }

  /**
   * Create a chat completion
   */
  async chatCompletion(params: OpenAI.ChatCompletionCreateParamsNonStreaming) {
    return this.client.chat.completions.create(params);
  }

  /**
   * Create a streaming chat completion
   */
  async chatCompletionStream(params: OpenAI.ChatCompletionCreateParamsStreaming) {
    return this.client.chat.completions.create(params);
  }

  /**
   * Get the underlying OpenAI client
   */
  getClient(): OpenAI {
    return this.client;
  }
}

/**
 * Create a Copilot provider instance
 */
export function createCopilotProvider(config?: CopilotProviderConfig): CopilotProvider {
  return new CopilotProvider(config);
}

/**
 * Model router for switching between models based on usage
 */
export class ModelRouter {
  private provider: CopilotProvider;
  private premiumModel: string;
  private fallbackModel: string;
  private usageThreshold: number;

  constructor(options: {
    provider: CopilotProvider;
    premiumModel?: string;
    fallbackModel?: string;
    usageThreshold?: number;
  }) {
    this.provider = options.provider;
    this.premiumModel = options.premiumModel ?? 'gpt-4';
    this.fallbackModel = options.fallbackModel ?? 'gpt-3.5-turbo';
    this.usageThreshold = options.usageThreshold ?? 0.8;
  }

  /**
   * Get the appropriate model based on current usage
   */
  async selectModel(): Promise<string> {
    try {
      const nearLimit = await this.provider.isNearLimit(this.usageThreshold);
      if (nearLimit) {
        console.log(`[ModelRouter] Near usage limit, switching to fallback model: ${this.fallbackModel}`);
        return this.fallbackModel;
      }
      return this.premiumModel;
    } catch (error) {
      console.warn('[ModelRouter] Failed to check usage, using fallback model:', error);
      return this.fallbackModel;
    }
  }

  /**
   * Create a chat completion with automatic model selection
   */
  async chatCompletion(
    params: Omit<OpenAI.ChatCompletionCreateParamsNonStreaming, 'model'>
  ) {
    const model = await this.selectModel();
    return this.provider.chatCompletion({ ...params, model });
  }
}

/**
 * Create a model router
 */
export function createModelRouter(
  provider: CopilotProvider,
  options?: {
    premiumModel?: string;
    fallbackModel?: string;
    usageThreshold?: number;
  }
): ModelRouter {
  return new ModelRouter({ provider, ...options });
}
