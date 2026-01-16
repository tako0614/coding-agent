/**
 * Settings store for application configuration
 * Stores API keys and other settings in SQLite
 *
 * SECURITY: Sensitive values (API keys, tokens) are encrypted at rest
 * using AES-256-GCM authenticated encryption.
 */

import { db } from './db.js';
import { encrypt, decrypt, isEncrypted } from './crypto.js';
import { logger } from './logger.js';

export type ExecutorMode = 'agent' | 'codex_only' | 'claude_only' | 'claude_direct' | 'codex_direct';

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
  // Spec agent model (for specification mode)
  spec_model?: string;
  // Claude executor model
  claude_model?: string;
  // Codex executor model
  codex_model?: string;
  // Executor mode: auto, codex_only, claude_only
  executor_mode?: ExecutorMode;
  // Shell command configuration
  shell_allowlist?: string[];
  shell_denylist?: string[];
  // Worker pool configuration
  max_workers?: number;
  task_timeout_ms?: number;
  // Agent context settings
  max_context_tokens?: number;
  // Agent timeout (overall execution)
  agent_timeout_ms?: number;
  // Command timeout
  command_timeout_ms?: number;
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
  SPEC_MODEL: 'spec_model',
  CLAUDE_MODEL: 'claude_model',
  CODEX_MODEL: 'codex_model',
  EXECUTOR_MODE: 'executor_mode',
  SHELL_ALLOWLIST: 'shell_allowlist',
  SHELL_DENYLIST: 'shell_denylist',
  MAX_WORKERS: 'max_workers',
  TASK_TIMEOUT_MS: 'task_timeout_ms',
  MAX_CONTEXT_TOKENS: 'max_context_tokens',
  AGENT_TIMEOUT_MS: 'agent_timeout_ms',
  COMMAND_TIMEOUT_MS: 'command_timeout_ms',
} as const;

/** Default max context tokens (150k) */
export const DEFAULT_MAX_CONTEXT_TOKENS = 150_000;

/** Default agent timeout (30 minutes) */
export const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;

/** Default command timeout (5 minutes) */
export const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

/** Default task timeout (10 minutes) */
export const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000;

/** Fallback API key for Copilot proxy (when no real key is needed) */
export const COPILOT_PROXY_KEY = 'copilot-proxy';

/** Minimum allowed max context tokens (10k) */
export const MIN_MAX_CONTEXT_TOKENS = 10_000;

/** Maximum allowed max context tokens (500k) */
export const MAX_MAX_CONTEXT_TOKENS = 500_000;

// Default shell command allowlist
export const DEFAULT_SHELL_ALLOWLIST = [
  'npm', 'npx', 'pnpm', 'yarn', 'bun',
  'node', 'deno', 'tsx', 'ts-node',
  'tsc', 'vitest', 'jest', 'mocha', 'ava',
  'eslint', 'prettier', 'biome',
  'git', 'gh',
  'cat', 'ls', 'pwd', 'echo', 'grep', 'find', 'head', 'tail',
  'mkdir', 'rm', 'cp', 'mv', 'touch',
  'curl', 'wget',
  'python', 'python3', 'pip', 'pip3',
  'go', 'cargo', 'rustc',
  'docker', 'docker-compose',
];

type SettingKey = typeof SETTING_KEYS[keyof typeof SETTING_KEYS];

/** Keys that contain sensitive data and should be encrypted */
const SENSITIVE_KEYS: readonly SettingKey[] = [
  SETTING_KEYS.OPENAI_API_KEY,
  SETTING_KEYS.ANTHROPIC_API_KEY,
  SETTING_KEYS.GITHUB_TOKEN,
] as const;

/**
 * Check if a setting key contains sensitive data
 */
function isSensitiveKey(key: SettingKey): boolean {
  return SENSITIVE_KEYS.includes(key);
}

// Lazy-initialized prepared statements
function getGetStmt() {
  return db.prepare('SELECT value FROM settings WHERE key = ?');
}

function getUpsertStmt() {
  return db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (@key, @value, @updated_at)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `);
}

function getDeleteStmt() {
  return db.prepare('DELETE FROM settings WHERE key = ?');
}

function getListStmt() {
  return db.prepare('SELECT key, value, updated_at FROM settings');
}

/**
 * Get a setting value
 * Automatically decrypts sensitive values
 */
export function getSetting(key: SettingKey): string | undefined {
  const row = getGetStmt().get(key) as { value: string } | undefined;
  if (!row?.value) {
    return undefined;
  }

  // Decrypt sensitive values
  if (isSensitiveKey(key) && isEncrypted(row.value)) {
    const decrypted = decrypt(row.value);
    if (decrypted === null) {
      logger.error('Failed to decrypt setting', { key });
      return undefined;
    }
    return decrypted;
  }

  return row.value;
}

/**
 * Set a setting value
 * Automatically encrypts sensitive values
 */
export function setSetting(key: SettingKey, value: string): void {
  let storedValue = value;

  // Encrypt sensitive values
  if (isSensitiveKey(key)) {
    const encrypted = encrypt(value);
    if (encrypted === null) {
      logger.error('Failed to encrypt setting', { key });
      throw new Error(`Failed to encrypt setting: ${key}`);
    }
    storedValue = encrypted;
  }

  getUpsertStmt().run({
    key,
    value: storedValue,
    updated_at: new Date().toISOString(),
  });
}

/**
 * Delete a setting
 */
export function deleteSetting(key: SettingKey): boolean {
  const result = getDeleteStmt().run(key);
  return result.changes > 0;
}

// Mapping from DB key to AppSettings field name and value transformer
type SettingTransform = { field: keyof AppSettings; transform?: (v: string) => unknown };
const KEY_TO_FIELD: Record<string, SettingTransform> = {
  [SETTING_KEYS.OPENAI_API_KEY]: { field: 'openai_api_key' },
  [SETTING_KEYS.ANTHROPIC_API_KEY]: { field: 'anthropic_api_key' },
  [SETTING_KEYS.DEFAULT_MODEL]: { field: 'default_model' },
  [SETTING_KEYS.COPILOT_API_URL]: { field: 'copilot_api_url' },
  [SETTING_KEYS.GITHUB_TOKEN]: { field: 'github_token' },
  [SETTING_KEYS.USE_COPILOT_API]: { field: 'use_copilot_api', transform: (v) => v === 'true' },
  [SETTING_KEYS.DAG_MODEL]: { field: 'dag_model' },
  [SETTING_KEYS.EXECUTOR_MODE]: { field: 'executor_mode' },
  [SETTING_KEYS.SPEC_MODEL]: { field: 'spec_model' },
  [SETTING_KEYS.CLAUDE_MODEL]: { field: 'claude_model' },
  [SETTING_KEYS.CODEX_MODEL]: { field: 'codex_model' },
};

/**
 * Get all settings as an object
 * Uses O(1) map lookup instead of switch statement
 */
export function getAllSettings(): AppSettings {
  const rows = getListStmt().all() as Array<{ key: string; value: string }>;
  const settings: AppSettings = {};

  for (const row of rows) {
    const mapping = KEY_TO_FIELD[row.key];
    if (mapping) {
      const value = mapping.transform ? mapping.transform(row.value) : row.value;
      (settings as Record<string, unknown>)[mapping.field] = value;
    }
  }

  return settings;
}

// Mapping from AppSettings field to DB key and value serializer
type SettingUpdate = { key: string; serialize?: (v: unknown) => string; alwaysUpsert?: boolean };
const FIELD_TO_KEY: Record<keyof AppSettings, SettingUpdate> = {
  openai_api_key: { key: SETTING_KEYS.OPENAI_API_KEY },
  anthropic_api_key: { key: SETTING_KEYS.ANTHROPIC_API_KEY },
  default_model: { key: SETTING_KEYS.DEFAULT_MODEL },
  copilot_api_url: { key: SETTING_KEYS.COPILOT_API_URL },
  github_token: { key: SETTING_KEYS.GITHUB_TOKEN },
  use_copilot_api: { key: SETTING_KEYS.USE_COPILOT_API, serialize: (v) => String(v), alwaysUpsert: true },
  dag_model: { key: SETTING_KEYS.DAG_MODEL },
  executor_mode: { key: SETTING_KEYS.EXECUTOR_MODE },
  spec_model: { key: SETTING_KEYS.SPEC_MODEL },
  claude_model: { key: SETTING_KEYS.CLAUDE_MODEL },
  codex_model: { key: SETTING_KEYS.CODEX_MODEL },
  // These fields are not stored in settings DB (handled separately or read-only)
  shell_allowlist: { key: SETTING_KEYS.SHELL_ALLOWLIST },
  shell_denylist: { key: SETTING_KEYS.SHELL_DENYLIST },
  max_workers: { key: SETTING_KEYS.MAX_WORKERS },
  task_timeout_ms: { key: SETTING_KEYS.TASK_TIMEOUT_MS },
  max_context_tokens: { key: SETTING_KEYS.MAX_CONTEXT_TOKENS },
  agent_timeout_ms: { key: SETTING_KEYS.AGENT_TIMEOUT_MS },
  command_timeout_ms: { key: SETTING_KEYS.COMMAND_TIMEOUT_MS },
};

/**
 * Update multiple settings at once
 * Uses loop over mapping instead of repeated if blocks
 */
export function updateSettings(settings: Partial<AppSettings>): void {
  const now = new Date().toISOString();

  for (const [field, mapping] of Object.entries(FIELD_TO_KEY)) {
    const value = settings[field as keyof AppSettings];
    if (value === undefined) continue;

    const serialized = mapping.serialize ? mapping.serialize(value) : String(value);

    if (value || mapping.alwaysUpsert) {
      getUpsertStmt().run({ key: mapping.key, value: serialized, updated_at: now });
    } else {
      getDeleteStmt().run(mapping.key);
    }
  }
}

/**
 * Get executor mode setting
 * Defaults to 'agent' (respects DAG node's executor_preference)
 */
export function getExecutorMode(): ExecutorMode {
  const fromSettings = getSetting(SETTING_KEYS.EXECUTOR_MODE);
  const validModes: ExecutorMode[] = ['agent', 'codex_only', 'claude_only', 'claude_direct', 'codex_direct'];
  if (fromSettings && validModes.includes(fromSettings as ExecutorMode)) {
    return fromSettings as ExecutorMode;
  }
  return 'agent';
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
 * Get Spec agent model setting
 * Defaults to claude-sonnet-4-20250514
 */
export function getSpecModel(): string {
  const fromSettings = getSetting(SETTING_KEYS.SPEC_MODEL);
  if (fromSettings) {
    return fromSettings;
  }
  return process.env['SPEC_MODEL'] || 'claude-sonnet-4-20250514';
}

/**
 * Get Claude executor model setting
 * Defaults to claude-sonnet-4-20250514
 */
export function getClaudeModel(): string {
  const fromSettings = getSetting(SETTING_KEYS.CLAUDE_MODEL);
  if (fromSettings) {
    return fromSettings;
  }
  return process.env['CLAUDE_MODEL'] || 'claude-sonnet-4-20250514';
}

/**
 * Get Codex executor model setting
 * Defaults to gpt-4.1
 */
export function getCodexModel(): string {
  const fromSettings = getSetting(SETTING_KEYS.CODEX_MODEL);
  if (fromSettings) {
    return fromSettings;
  }
  return process.env['CODEX_MODEL'] || 'gpt-4.1';
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

  // If Copilot API is enabled AND has a valid token, use it
  if (copilotConfig.enabled && copilotConfig.githubToken) {
    return {
      apiKey: copilotConfig.githubToken,
      baseUrl: `${copilotConfig.baseUrl}/v1`,
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

/**
 * Get shell command allowlist
 */
export function getShellAllowlist(): string[] {
  const fromSettings = getSetting(SETTING_KEYS.SHELL_ALLOWLIST);
  if (fromSettings) {
    try {
      const parsed = JSON.parse(fromSettings);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Fall through to default
    }
  }
  return DEFAULT_SHELL_ALLOWLIST;
}

/**
 * Set shell command allowlist
 */
export function setShellAllowlist(allowlist: string[]): void {
  setSetting(SETTING_KEYS.SHELL_ALLOWLIST, JSON.stringify(allowlist));
}

/**
 * Get shell command denylist
 */
export function getShellDenylist(): string[] {
  const fromSettings = getSetting(SETTING_KEYS.SHELL_DENYLIST);
  if (fromSettings) {
    try {
      const parsed = JSON.parse(fromSettings);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Fall through to default
    }
  }
  return [];
}

/**
 * Set shell command denylist
 */
export function setShellDenylist(denylist: string[]): void {
  setSetting(SETTING_KEYS.SHELL_DENYLIST, JSON.stringify(denylist));
}

/**
 * Get max workers setting
 */
export function getMaxWorkers(): number {
  const fromSettings = getSetting(SETTING_KEYS.MAX_WORKERS);
  if (fromSettings) {
    const parsed = parseInt(fromSettings, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  // Import constant at runtime to avoid circular dependency
  return 5; // DEFAULT from protocol
}

/**
 * Set max workers
 */
export function setMaxWorkers(maxWorkers: number): void {
  setSetting(SETTING_KEYS.MAX_WORKERS, String(maxWorkers));
}

/**
 * Get task timeout in milliseconds
 */
export function getTaskTimeoutMs(): number {
  const fromSettings = getSetting(SETTING_KEYS.TASK_TIMEOUT_MS);
  if (fromSettings) {
    const parsed = parseInt(fromSettings, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 300_000; // 5 minutes default
}

/**
 * Set task timeout in milliseconds
 */
export function setTaskTimeoutMs(timeoutMs: number): void {
  setSetting(SETTING_KEYS.TASK_TIMEOUT_MS, String(timeoutMs));
}

/**
 * Get complete shell execution configuration
 */
export interface ShellConfig {
  allowlist: string[];
  denylist: string[];
  maxExecutionTimeMs: number;
  maxOutputSizeBytes: number;
}

export function getShellConfig(): ShellConfig {
  return {
    allowlist: getShellAllowlist(),
    denylist: getShellDenylist(),
    maxExecutionTimeMs: getTaskTimeoutMs(),
    maxOutputSizeBytes: 10 * 1024 * 1024, // 10MB
  };
}

/**
 * Get max context tokens for agent
 */
export function getMaxContextTokens(): number {
  const fromSettings = getSetting(SETTING_KEYS.MAX_CONTEXT_TOKENS);
  if (fromSettings) {
    const parsed = parseInt(fromSettings, 10);
    if (!isNaN(parsed) && parsed >= MIN_MAX_CONTEXT_TOKENS && parsed <= MAX_MAX_CONTEXT_TOKENS) {
      return parsed;
    }
  }
  return DEFAULT_MAX_CONTEXT_TOKENS;
}

/**
 * Set max context tokens for agent
 * @param tokens - Value between MIN_MAX_CONTEXT_TOKENS and MAX_MAX_CONTEXT_TOKENS
 * @throws Error if value is out of bounds
 */
export function setMaxContextTokens(tokens: number): void {
  if (tokens < MIN_MAX_CONTEXT_TOKENS || tokens > MAX_MAX_CONTEXT_TOKENS) {
    throw new Error(
      `max_context_tokens must be between ${MIN_MAX_CONTEXT_TOKENS} and ${MAX_MAX_CONTEXT_TOKENS}, got ${tokens}`
    );
  }
  setSetting(SETTING_KEYS.MAX_CONTEXT_TOKENS, String(tokens));
}

/**
 * Get agent timeout in milliseconds
 */
export function getAgentTimeoutMs(): number {
  const fromSettings = getSetting(SETTING_KEYS.AGENT_TIMEOUT_MS);
  if (fromSettings) {
    const parsed = parseInt(fromSettings, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const fromEnv = process.env['AGENT_TIMEOUT_MS'];
  if (fromEnv) {
    const parsed = parseInt(fromEnv, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_AGENT_TIMEOUT_MS;
}

/**
 * Set agent timeout in milliseconds
 */
export function setAgentTimeoutMs(timeoutMs: number): void {
  setSetting(SETTING_KEYS.AGENT_TIMEOUT_MS, String(timeoutMs));
}

/**
 * Get command timeout in milliseconds
 */
export function getCommandTimeoutMs(): number {
  const fromSettings = getSetting(SETTING_KEYS.COMMAND_TIMEOUT_MS);
  if (fromSettings) {
    const parsed = parseInt(fromSettings, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const fromEnv = process.env['COMMAND_TIMEOUT_MS'];
  if (fromEnv) {
    const parsed = parseInt(fromEnv, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_COMMAND_TIMEOUT_MS;
}

/**
 * Set command timeout in milliseconds
 */
export function setCommandTimeoutMs(timeoutMs: number): void {
  setSetting(SETTING_KEYS.COMMAND_TIMEOUT_MS, String(timeoutMs));
}
