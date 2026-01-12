/**
 * Settings API routes
 */

import { Hono } from 'hono';
import { z } from 'zod';
import {
  getAllSettings,
  updateSettings,
  getMaxContextTokens,
  setMaxContextTokens,
  getDAGModel,
  getExecutorMode,
  MIN_MAX_CONTEXT_TOKENS,
  MAX_MAX_CONTEXT_TOKENS,
  type AppSettings,
} from '../../services/settings-store.js';
import { copilotAPIManager } from '../../services/copilot-api-manager.js';
import { logger } from '../../services/logger.js';

const settings = new Hono();

const UpdateSettingsSchema = z.object({
  openai_api_key: z.string().optional(),
  anthropic_api_key: z.string().optional(),
  default_model: z.string().optional(),
  // Copilot API settings
  copilot_api_url: z.string().optional(),
  github_token: z.string().optional(),
  use_copilot_api: z.boolean().optional(),
  // DAG model (for LangGraph)
  dag_model: z.string().optional(),
  // Executor mode
  executor_mode: z.enum(['agent', 'codex_only', 'claude_only']).optional(),
  // Max context tokens (with validation bounds)
  max_context_tokens: z.number()
    .min(MIN_MAX_CONTEXT_TOKENS, `min_context_tokens must be at least ${MIN_MAX_CONTEXT_TOKENS}`)
    .max(MAX_MAX_CONTEXT_TOKENS, `max_context_tokens must be at most ${MAX_MAX_CONTEXT_TOKENS}`)
    .optional(),
});

/**
 * GET /api/settings
 * Get all settings (API keys are masked for security)
 */
settings.get('/', (c) => {
  const allSettings = getAllSettings();

  // Mask API keys for security (show only last 4 chars)
  const masked = {
    ...allSettings,
    openai_api_key: allSettings.openai_api_key
      ? `****${allSettings.openai_api_key.slice(-4)}`
      : undefined,
    anthropic_api_key: allSettings.anthropic_api_key
      ? `****${allSettings.anthropic_api_key.slice(-4)}`
      : undefined,
    github_token: allSettings.github_token
      ? `****${allSettings.github_token.slice(-4)}`
      : undefined,
    openai_api_key_set: !!allSettings.openai_api_key,
    anthropic_api_key_set: !!allSettings.anthropic_api_key,
    github_token_set: !!allSettings.github_token,
    // Include additional settings with defaults
    dag_model: getDAGModel(),
    executor_mode: getExecutorMode(),
    max_context_tokens: getMaxContextTokens(),
  };

  return c.json(masked);
});

/**
 * PUT /api/settings
 * Update settings
 */
settings.put('/', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = UpdateSettingsSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({
        error: {
          message: 'Invalid request body',
          details: parsed.error.errors,
        },
      }, 400);
    }

    // Get previous copilot state
    const prevSettings = getAllSettings();
    const hadToken = !!prevSettings.github_token;

    // Handle max_context_tokens separately (since it uses its own setter)
    if (parsed.data.max_context_tokens !== undefined) {
      setMaxContextTokens(parsed.data.max_context_tokens);
      logger.info('max_context_tokens updated', { value: parsed.data.max_context_tokens });
    }

    updateSettings(parsed.data);
    logger.info('Settings updated');

    // Auto-start/stop copilot-api based on github_token change
    if (parsed.data.github_token !== undefined) {
      const hasToken = !!parsed.data.github_token;
      if (hasToken && !hadToken) {
        logger.info('GitHub token set, starting copilot-api');
        copilotAPIManager.start().catch((err) => {
          logger.error('Failed to start copilot-api', { error: err instanceof Error ? err.message : String(err) });
        });
      } else if (!hasToken && hadToken) {
        logger.info('GitHub token cleared, stopping copilot-api');
        copilotAPIManager.stop().catch((err) => {
          logger.error('Failed to stop copilot-api', { error: err instanceof Error ? err.message : String(err) });
        });
      }
    }

    // Return masked settings
    const allSettings = getAllSettings();
    const masked = {
      openai_api_key: allSettings.openai_api_key
        ? `****${allSettings.openai_api_key.slice(-4)}`
        : undefined,
      anthropic_api_key: allSettings.anthropic_api_key
        ? `****${allSettings.anthropic_api_key.slice(-4)}`
        : undefined,
      github_token: allSettings.github_token
        ? `****${allSettings.github_token.slice(-4)}`
        : undefined,
      default_model: allSettings.default_model,
      copilot_api_url: allSettings.copilot_api_url,
      use_copilot_api: allSettings.use_copilot_api,
      openai_api_key_set: !!allSettings.openai_api_key,
      anthropic_api_key_set: !!allSettings.anthropic_api_key,
      github_token_set: !!allSettings.github_token,
      // Include additional settings with defaults
      dag_model: getDAGModel(),
      executor_mode: getExecutorMode(),
      max_context_tokens: getMaxContextTokens(),
    };

    return c.json(masked);
  } catch (error) {
    logger.error('Error updating settings', { error: error instanceof Error ? error.message : String(error) });
    return c.json({
      error: {
        message: error instanceof Error ? error.message : 'Internal server error',
      },
    }, 500);
  }
});

/**
 * DELETE /api/settings/:key
 * Delete a specific setting
 */
settings.delete('/:key', (c) => {
  const key = c.req.param('key');

  // Only allow deleting known keys
  const allowedKeys = ['openai_api_key', 'anthropic_api_key', 'default_model', 'copilot_api_url', 'github_token', 'use_copilot_api', 'dag_model', 'executor_mode', 'max_context_tokens'];
  if (!allowedKeys.includes(key)) {
    return c.json({
      error: {
        message: `Unknown setting: ${key}`,
      },
    }, 400);
  }

  if (key === 'use_copilot_api') {
    updateSettings({ use_copilot_api: false });
  } else {
    updateSettings({ [key]: '' });
  }
  logger.info('Setting deleted', { key });

  return c.json({ message: `Setting ${key} deleted` });
});

export { settings };
