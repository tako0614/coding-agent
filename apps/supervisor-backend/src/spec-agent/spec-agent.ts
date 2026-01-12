/**
 * SpecAgent - Specification mode agent
 * Chat-based agent for creating and editing specifications
 */

import Anthropic from '@anthropic-ai/sdk';
import { getSpecModel, getAnthropicApiKey } from '../services/settings-store.js';
import { logger } from '../services/logger.js';
import { getErrorMessage } from '../services/errors.js';
import { SPEC_TOOLS, executeTool, type ToolResult } from './spec-tools.js';
import {
  getConversation,
  addMessage,
  addMessageLocked,
  toAnthropicMessages,
  type ConversationMessage,
  type Conversation,
} from './spec-store.js';
import { withRunLock, LockTimeoutError } from '../services/run-lock.js';

const SPEC_SYSTEM_PROMPT = `あなたは仕様策定アシスタントです。ユーザーと対話しながら仕様書を作成します。

## 役割
- ユーザーの要件をヒアリングして理解する
- 既存のコードベースを参照して現状を把握する
- 仕様書（Markdown等）を作成・編集する
- 曖昧な点は質問して明確化する

## 使用可能なツール
- read_file: 既存のコードや仕様書を読む
- edit_file: 仕様書を作成・編集する
- list_files: プロジェクト構造を確認する
- complete: 仕様策定が完了したら呼び出す

## 注意事項
- コードの実装は行いません（仕様策定のみ）
- 仕様書のファイルパスはユーザーに確認してから決定してください
- 技術的な実装詳細は実装モードに委ねてください
- 日本語で応答してください（ユーザーが英語で話しかけた場合は英語で）

## 仕様書の構成例
1. 概要 - 何を実現するか
2. 背景 - なぜ必要か
3. 要件 - 機能要件・非機能要件
4. 設計 - アーキテクチャ・データフロー
5. インターフェース - API・UI
6. 制約・前提条件`;

export interface SpecAgentConfig {
  runId: string;
  repoPath: string;
}

export interface ChatResponse {
  message: string;
  tool_calls?: Array<{
    tool: string;
    input: Record<string, unknown>;
    output: string;
  }>;
  completed?: boolean;
  completionSummary?: string;
}

/** Maximum user message length (100KB) */
const MAX_MESSAGE_LENGTH = 100 * 1024;

/** Maximum tool use iterations to prevent infinite loops */
const MAX_TOOL_ITERATIONS = 50;

export class SpecAgent {
  private config: SpecAgentConfig;
  private client: Anthropic;
  private model: string;

  constructor(config: SpecAgentConfig) {
    this.config = config;
    this.model = getSpecModel();

    const apiKey = getAnthropicApiKey();
    if (!apiKey) {
      throw new Error('Anthropic API key not configured');
    }

    this.client = new Anthropic({ apiKey });

    logger.info('SpecAgent created', {
      runId: config.runId,
      model: this.model,
    });
  }

  /**
   * Process a user message and return a response
   * Uses run lock to prevent concurrent modifications
   */
  async chat(userMessage: string): Promise<ChatResponse> {
    // Use run lock to prevent concurrent chat requests
    return withRunLock(
      this.config.runId,
      'chat',
      async () => this.processChatMessage(userMessage),
      { holdTimeoutMs: 600_000 } // 10 minute timeout for long conversations
    );
  }

  /**
   * Internal chat processing (called within lock)
   */
  private async processChatMessage(userMessage: string): Promise<ChatResponse> {
    // Validate message length
    if (userMessage.length > MAX_MESSAGE_LENGTH) {
      throw new Error(`Message too long. Maximum length is ${MAX_MESSAGE_LENGTH} characters`);
    }

    // Add user message to conversation
    addMessage(this.config.runId, {
      role: 'user',
      content: userMessage,
      timestamp: new Date().toISOString(),
    });

    // Get conversation history
    const conversation = getConversation(this.config.runId);
    if (!conversation) {
      throw new Error('Failed to get conversation');
    }

    // Convert to Anthropic format
    const messages = toAnthropicMessages(conversation.messages);

    let completed = false;
    let completionSummary: string | undefined;
    const toolCalls: Array<{
      tool: string;
      input: Record<string, unknown>;
      output: string;
    }> = [];

    // Loop for tool use with safety limit
    let finalResponse = '';
    let iterationCount = 0;

    while (iterationCount < MAX_TOOL_ITERATIONS) {
      iterationCount++;

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: SPEC_SYSTEM_PROMPT,
        tools: SPEC_TOOLS.map(tool => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.input_schema,
        })),
        messages,
      });

      // Process response content
      let hasToolUse = false;
      const assistantContentBlocks: Array<Anthropic.Messages.TextBlock | Anthropic.Messages.ToolUseBlock> = [];

      for (const block of response.content) {
        // Only include text and tool_use blocks
        if (block.type === 'text') {
          assistantContentBlocks.push(block);
          finalResponse = block.text;
        } else if (block.type === 'tool_use') {
          assistantContentBlocks.push(block);
          hasToolUse = true;
          const toolInput = block.input as Record<string, unknown>;

          logger.debug('SpecAgent tool call', {
            runId: this.config.runId,
            tool: block.name,
            input: toolInput,
          });

          // Execute tool
          const result = await executeTool(block.name, toolInput, this.config.repoPath);

          toolCalls.push({
            tool: block.name,
            input: toolInput,
            output: result.success ? (result.output ?? '') : (result.error ?? 'Unknown error'),
          });

          // Check for completion
          if (block.name === 'complete' && result.success) {
            completed = true;
            completionSummary = toolInput['summary'] as string;
          }

          // Add assistant message with tool use
          messages.push({
            role: 'assistant',
            content: assistantContentBlocks as unknown as string,
          });

          // Add tool result
          messages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: block.id,
              content: result.success ? (result.output ?? 'Success') : `Error: ${result.error}`,
            }] as unknown as string,
          });
        }
      }

      // If no tool use, we're done
      if (!hasToolUse || response.stop_reason === 'end_turn') {
        break;
      }
    }

    // Check if we hit the iteration limit
    if (iterationCount >= MAX_TOOL_ITERATIONS) {
      logger.warn('SpecAgent hit tool iteration limit', {
        runId: this.config.runId,
        iterations: iterationCount,
      });
    }

    // Save assistant response
    addMessage(this.config.runId, {
      role: 'assistant',
      content: finalResponse,
      timestamp: new Date().toISOString(),
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    });

    return {
      message: finalResponse,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      completed,
      completionSummary,
    };
  }

  /**
   * Get conversation history
   */
  getConversation(): Conversation | undefined {
    return getConversation(this.config.runId);
  }

  /**
   * Get run ID
   */
  getRunId(): string {
    return this.config.runId;
  }
}

import { db } from '../services/db.js';

// Prepared statements for spec agent sessions
const insertSessionStmt = db.prepare(`
  INSERT OR REPLACE INTO spec_agent_sessions (run_id, repo_path, model, created_at, last_active_at)
  VALUES (@run_id, @repo_path, @model, @created_at, @last_active_at)
`);

const getSessionStmt = db.prepare(`
  SELECT * FROM spec_agent_sessions WHERE run_id = ?
`);

const deleteSessionStmt = db.prepare(`
  DELETE FROM spec_agent_sessions WHERE run_id = ?
`);

const updateLastActiveStmt = db.prepare(`
  UPDATE spec_agent_sessions SET last_active_at = ? WHERE run_id = ?
`);

interface SessionRow {
  run_id: string;
  repo_path: string;
  model: string | null;
  created_at: string;
  last_active_at: string;
}

/**
 * SpecAgent store for managing active agents
 * Persists session metadata to database for server restart recovery
 */
class SpecAgentStore {
  private agents: Map<string, SpecAgent> = new Map();

  get(runId: string): SpecAgent | undefined {
    // Check in-memory first
    const agent = this.agents.get(runId);
    if (agent) {
      // Update last active time
      this.updateLastActive(runId);
      return agent;
    }

    // Try to restore from database
    return this.tryRestore(runId);
  }

  /**
   * Try to restore an agent from persisted session
   */
  private tryRestore(runId: string): SpecAgent | undefined {
    try {
      const row = getSessionStmt.get(runId) as SessionRow | undefined;
      if (!row) return undefined;

      // Recreate the agent from persisted config
      logger.info('Restoring SpecAgent from persisted session', { runId });
      const agent = new SpecAgent({
        runId: row.run_id,
        repoPath: row.repo_path,
      });
      this.agents.set(runId, agent);

      // Update last active time
      this.updateLastActive(runId);

      return agent;
    } catch (err) {
      logger.error('Failed to restore SpecAgent', {
        runId,
        error: getErrorMessage(err),
      });
      return undefined;
    }
  }

  create(config: SpecAgentConfig): SpecAgent {
    const agent = new SpecAgent(config);
    this.agents.set(config.runId, agent);

    // Persist session to database
    const now = new Date().toISOString();
    try {
      insertSessionStmt.run({
        run_id: config.runId,
        repo_path: config.repoPath,
        model: getSpecModel(),
        created_at: now,
        last_active_at: now,
      });
    } catch (err) {
      logger.error('Failed to persist SpecAgent session', {
        runId: config.runId,
        error: getErrorMessage(err),
      });
    }

    return agent;
  }

  getOrCreate(config: SpecAgentConfig): SpecAgent {
    const existing = this.agents.get(config.runId);
    if (existing) return existing;

    // Try to restore from database first
    const restored = this.tryRestore(config.runId);
    if (restored) return restored;

    return this.create(config);
  }

  delete(runId: string): boolean {
    // Remove from memory
    const memDeleted = this.agents.delete(runId);

    // Remove from database
    try {
      deleteSessionStmt.run(runId);
    } catch (err) {
      logger.error('Failed to delete SpecAgent session', {
        runId,
        error: getErrorMessage(err),
      });
    }

    return memDeleted;
  }

  clear(): void {
    this.agents.clear();
  }

  /**
   * Update the last active timestamp for a session
   */
  private updateLastActive(runId: string): void {
    try {
      updateLastActiveStmt.run(new Date().toISOString(), runId);
    } catch {
      // Ignore errors for non-critical update
    }
  }
}

export const specAgentStore = new SpecAgentStore();
