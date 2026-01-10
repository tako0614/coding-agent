/**
 * Settings store for application configuration
 * Stores API keys and other settings in SQLite
 */

import { db } from './db.js';

export interface AppSettings {
  openai_api_key?: string;
  anthropic_api_key?: string;
  default_model?: string;
  // Copilot API settings
  copilot_api_url?: string;
  github_token?: string;
  use_copilot_api?: boolean;
  // DAG building model (for LangGraph)
  dag_model?: string;
}

// Known setting keys
export const SETTING_KEYS = {
  OPENAI_API_KEY: 'openai_api_key',
  ANTHROPIC_API_KEY: 'anthropic_api_key',
  DEFAULT_MODEL: 'default_model',
  COPILOT_API_URL: 'copilot_api_url',
  GITHUB_TOKEN: 'github_token',
  USE_COPILOT_API: 'use_copilot_api',
  DAG_MODEL: 'dag_model',
} as const;

type SettingKey = typeof SETTING_KEYS[keyof typeof SETTING_KEYS];

const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const upsertStmt = db.prepare(`
  INSERT INTO settings (key, value, updated_at)
  VALUES (@key, @value, @updated_at)
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    updated_at = excluded.updated_at
`);
const deleteStmt = db.prepare('DELETE FROM settings WHERE key = ?');
const listStmt = db.prepare('SELECT key, value, updated_at FROM settings');

/**
 * Get a setting value
 */
export function getSetting(key: SettingKey): string | undefined {
  const row = getStmt.get(key) as { value: string } | undefined;
  return row?.value;
}

/**
 * Set a setting value
 */
export function setSetting(key: SettingKey, value: string): void {
  upsertStmt.run({
    key,
    value,
    updated_at: new Date().toISOString(),
  });
}

/**
 * Delete a setting
 */
export function deleteSetting(key: SettingKey): boolean {
  const result = deleteStmt.run(key);
  return result.changes > 0;
}

/**
 * Get all settings as an object
 */
export function getAllSettings(): AppSettings {
  const rows = listStmt.all() as Array<{ key: string; value: string }>;
  const settings: AppSettings = {};

  for (const row of rows) {
    switch (row.key) {
      case SETTING_KEYS.OPENAI_API_KEY:
        settings.openai_api_key = row.value;
        break;
      case SETTING_KEYS.ANTHROPIC_API_KEY:
        settings.anthropic_api_key = row.value;
        break;
      case SETTING_KEYS.DEFAULT_MODEL:
        settings.default_model = row.value;
        break;
      case SETTING_KEYS.COPILOT_API_URL:
        settings.copilot_api_url = row.value;
        break;
      case SETTING_KEYS.GITHUB_TOKEN:
        settings.github_token = row.value;
        break;
      case SETTING_KEYS.USE_COPILOT_API:
        settings.use_copilot_api = row.value === 'true';
        break;
      case SETTING_KEYS.DAG_MODEL:
        settings.dag_model = row.value;
        break;
    }
  }

  return settings;
}

/**
 * Update multiple settings at once
 */
export function updateSettings(settings: Partial<AppSettings>): void {
  const now = new Date().toISOString();

  if (settings.openai_api_key !== undefined) {
    if (settings.openai_api_key) {
      upsertStmt.run({ key: SETTING_KEYS.OPENAI_API_KEY, value: settings.openai_api_key, updated_at: now });
    } else {
      deleteStmt.run(SETTING_KEYS.OPENAI_API_KEY);
    }
  }

  if (settings.anthropic_api_key !== undefined) {
    if (settings.anthropic_api_key) {
      upsertStmt.run({ key: SETTING_KEYS.ANTHROPIC_API_KEY, value: settings.anthropic_api_key, updated_at: now });
    } else {
      deleteStmt.run(SETTING_KEYS.ANTHROPIC_API_KEY);
    }
  }

  if (settings.default_model !== undefined) {
    if (settings.default_model) {
      upsertStmt.run({ key: SETTING_KEYS.DEFAULT_MODEL, value: settings.default_model, updated_at: now });
    } else {
      deleteStmt.run(SETTING_KEYS.DEFAULT_MODEL);
    }
  }

  if (settings.copilot_api_url !== undefined) {
    if (settings.copilot_api_url) {
      upsertStmt.run({ key: SETTING_KEYS.COPILOT_API_URL, value: settings.copilot_api_url, updated_at: now });
    } else {
      deleteStmt.run(SETTING_KEYS.COPILOT_API_URL);
    }
  }

  if (settings.github_token !== undefined) {
    if (settings.github_token) {
      upsertStmt.run({ key: SETTING_KEYS.GITHUB_TOKEN, value: settings.github_token, updated_at: now });
    } else {
      deleteStmt.run(SETTING_KEYS.GITHUB_TOKEN);
    }
  }

  if (settings.use_copilot_api !== undefined) {
    upsertStmt.run({ key: SETTING_KEYS.USE_COPILOT_API, value: String(settings.use_copilot_api), updated_at: now });
  }

  if (settings.dag_model !== undefined) {
    if (settings.dag_model) {
      upsertStmt.run({ key: SETTING_KEYS.DAG_MODEL, value: settings.dag_model, updated_at: now });
    } else {
      deleteStmt.run(SETTING_KEYS.DAG_MODEL);
    }
  }
}

/**
 * Get DAG model setting (for LangGraph)
 * Defaults to gpt-5.2
 */
export function getDAGModel(): string {
  const fromSettings = getSetting(SETTING_KEYS.DAG_MODEL);
  if (fromSettings) {
    return fromSettings;
  }
  return process.env['DAG_MODEL'] || 'gpt-5.2';
}

/**
 * Get Copilot API configuration
 */
export interface CopilotAPIConfig {
  enabled: boolean;
  baseUrl: string;
  githubToken?: string;
}

export function getCopilotAPIConfig(): CopilotAPIConfig {
  const settings = getAllSettings();
  const githubToken = settings.github_token || process.env['GITHUB_TOKEN'];
  // Auto-enable if github token is available
  const enabled = !!githubToken;
  const baseUrl = settings.copilot_api_url || process.env['COPILOT_API_URL'] || 'http://localhost:4141';

  return { enabled, baseUrl, githubToken };
}

/**
 * Get OpenAI API configuration (supports both direct OpenAI and Copilot API proxy)
 */
export interface OpenAIConfig {
  apiKey: string;
  baseUrl?: string;
  useCopilot: boolean;
}

export function getOpenAIConfig(): OpenAIConfig | undefined {
  const copilotConfig = getCopilotAPIConfig();

  // If Copilot API is enabled, use it
  if (copilotConfig.enabled) {
    // Copilot API doesn't need an API key, but we'll use a dummy one for compatibility
    return {
      apiKey: copilotConfig.githubToken || 'copilot-proxy',
      baseUrl: copilotConfig.baseUrl,
      useCopilot: true,
    };
  }

  // Otherwise, use direct OpenAI
  const apiKey = getOpenAIApiKey();
  if (apiKey) {
    return {
      apiKey,
      useCopilot: false,
    };
  }

  return undefined;
}

/**
 * Get OpenAI API key (from settings or environment)
 */
export function getOpenAIApiKey(): string | undefined {
  // Settings take precedence over environment
  const fromSettings = getSetting(SETTING_KEYS.OPENAI_API_KEY);
  if (fromSettings) {
    return fromSettings;
  }
  return process.env['OPENAI_API_KEY'];
}

/**
 * Get Anthropic API key (from settings or environment)
 */
export function getAnthropicApiKey(): string | undefined {
  const fromSettings = getSetting(SETTING_KEYS.ANTHROPIC_API_KEY);
  if (fromSettings) {
    return fromSettings;
  }
  return process.env['ANTHROPIC_API_KEY'];
}

/**
 * Get GitHub token (from settings or environment)
 */
export function getGitHubToken(): string | undefined {
  const fromSettings = getSetting(SETTING_KEYS.GITHUB_TOKEN);
  if (fromSettings) {
    return fromSettings;
  }
  return process.env['GITHUB_TOKEN'];
}
