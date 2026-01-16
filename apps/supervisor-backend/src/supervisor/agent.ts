/**
 * Supervisor Agent
 * Orchestrates Worker Agents using Copilot API (GPT)
 */

import OpenAI from 'openai';
import { getEncoding, type Tiktoken } from 'js-tiktoken';
import type {
  SupervisorState,
  SupervisorMessage,
  WorkerTask,
  WorkerTaskResult,
} from './types.js';
import { SUPERVISOR_TOOLS, ToolExecutor } from './tools.js';
import { logger } from '../services/logger.js';
import { getOpenAIConfig, getDAGModel, getMaxContextTokens, DEFAULT_MAX_CONTEXT_TOKENS } from '../services/settings-store.js';
import { getErrorMessage, isRetryableError as checkRetryableError } from '../services/errors.js';

// =============================================================================
// Constants (configurable via environment variables)
// =============================================================================

/** Maximum retries for API calls */
const MAX_API_RETRIES = parseInt(process.env['SUPERVISOR_MAX_API_RETRIES'] ?? '3', 10);

/** Base delay for exponential backoff (ms) */
const BASE_RETRY_DELAY_MS = parseInt(process.env['SUPERVISOR_RETRY_DELAY_MS'] ?? '1000', 10);

/** Max consecutive responses without tool calls before warning */
const MAX_NO_TOOL_RESPONSES = parseInt(process.env['SUPERVISOR_MAX_NO_TOOL_RESPONSES'] ?? '5', 10);

/** Max consecutive errors before failing */
const MAX_CONSECUTIVE_ERRORS = parseInt(process.env['SUPERVISOR_MAX_CONSECUTIVE_ERRORS'] ?? '10', 10);

/** Max summarization attempts per step to prevent loops */
const MAX_SUMMARIZATION_ATTEMPTS = parseInt(process.env['SUPERVISOR_MAX_SUMMARIZATION_ATTEMPTS'] ?? '2', 10);

/** Default agent timeout in ms (30 minutes) */
const DEFAULT_AGENT_TIMEOUT_MS = parseInt(process.env['SUPERVISOR_TIMEOUT_MS'] ?? String(30 * 60 * 1000), 10);

/** Maximum number of messages before forcing summarization */
const MAX_MESSAGES_BEFORE_SUMMARIZATION = parseInt(process.env['SUPERVISOR_MAX_MESSAGES_BEFORE_SUMMARIZATION'] ?? '100', 10);

/** Absolute maximum messages (hard limit for memory safety) */
const MAX_MESSAGES_HARD_LIMIT = parseInt(process.env['SUPERVISOR_MAX_MESSAGES_HARD_LIMIT'] ?? '500', 10);

// =============================================================================
// Utilities
// =============================================================================

/** Tiktoken encoder instance (lazy initialized) */
let tiktokenEncoder: Tiktoken | null = null;

/**
 * Get or create tiktoken encoder
 */
function getTokenEncoder(): Tiktoken {
  if (!tiktokenEncoder) {
    // Use cl100k_base encoding (used by GPT-4, GPT-3.5-turbo)
    tiktokenEncoder = getEncoding('cl100k_base');
  }
  return tiktokenEncoder;
}

/**
 * Count tokens accurately using tiktoken
 */
function countTokens(text: string): number {
  try {
    const encoder = getTokenEncoder();
    return encoder.encode(text).length;
  } catch (error) {
    // Fallback to rough estimation if tiktoken fails
    logger.warn('Tiktoken encoding failed, using fallback estimation', {
      error: getErrorMessage(error),
    });
    // Use conservative estimate: ~2 tokens per character for CJK, ~0.25 for ASCII
    const cjkChars = (text.match(/[\u3000-\u9fff\uac00-\ud7af]/g) || []).length;
    const otherChars = text.length - cjkChars;
    return Math.ceil(cjkChars * 2 + otherChars / 4);
  }
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// isRetryableError is now imported from ../services/errors.js as checkRetryableError

// =============================================================================
// System Prompt
// =============================================================================

const SUPERVISOR_SYSTEM_PROMPT = `あなたはSupervisor Agentです。ユーザーの目標を達成するために、Worker Agentを自由に指揮します。

## 役割
- 目標を理解し、必要なタスクを洗い出す
- 複数のWorkerを並列に起動して効率的に作業を進める
- 状況に応じて柔軟に追加タスクを発行する
- 全体の完了判定を行う

## 使用可能なツール

### ファイル操作
- read_file: ファイル内容を読む
- edit_file: ファイルを編集（置換）または新規作成
- list_files: ディレクトリ構造を確認

### Worker管理
- spawn_workers_async: 複数Workerを非同期起動（推奨）
- spawn_workers: 同期実行（完了まで待機）
- wait_workers: 実行中Workerの完了を待つ
- get_worker_status: 状態確認
- cancel_worker: キャンセル

### その他
- run_command: シェルコマンド実行
- complete: 完了宣言
- fail: 失敗宣言

## 動作方針

**自由に並列実行せよ:**
- 一度に多くのタスクをspawn_workers_asyncで起動してよい
- 待機せずに次々とタスクを追加してよい
- 必要なときだけwait_workersで結果を確認
- 順番にこだわらず、効率を優先

**例: 大きな機能実装**
\`\`\`
// 最初に複数タスクを一気に起動
spawn_workers_async([
  {instruction: "src/api/の認証機能を実装", executor: "codex"},
  {instruction: "src/db/のスキーマを更新", executor: "codex"},
  {instruction: "テストファイルを作成", executor: "codex"},
  {instruction: "ドキュメントを更新", executor: "claude"},
])

// 必要に応じて追加タスクも起動（待たずに）
spawn_workers_async([
  {instruction: "設定ファイルを更新", executor: "codex"},
])

// 一定の作業が溜まったら結果確認
wait_workers()
\`\`\`

**例: 調査と実装の並行**
\`\`\`
// 調査タスクを先に起動
spawn_workers_async([
  {instruction: "既存の認証コードを分析", executor: "claude"},
])

// 調査を待たずに確実な部分から実装開始
spawn_workers_async([
  {instruction: "新しいAPIエンドポイントの雛形を作成", executor: "codex"},
])

// 後でまとめて確認
wait_workers()
\`\`\`

## executor選択
- claude: 分析、レビュー、設計、複雑な判断
- codex: 実装、コード生成、ファイル編集

## 注意
- Workerへの指示は具体的に（ファイルパス、期待する変更を明記）
- 最終的にwait_workersで全結果を取得してからcompleteを呼ぶ
- 簡単な編集はedit_fileで直接実行可能
`;

// =============================================================================
// Supervisor Agent Class
// =============================================================================

export interface SupervisorAgentEvents {
  onStateChange?: (state: SupervisorState) => void;
  onWorkerStart?: (task: WorkerTask) => void;
  onWorkerComplete?: (result: WorkerTaskResult) => void;
  onThinking?: (content: string) => void;
}

export interface SupervisorAgentOptions {
  runId: string;  // Run ID from the caller - DO NOT generate a new one
  repoPath: string;
  userGoal: string;
  events?: SupervisorAgentEvents;
  workerExecutor?: (tasks: WorkerTask[], signal?: AbortSignal) => Promise<WorkerTaskResult[]>;
  /** Overall timeout in ms (default: 30 minutes) */
  timeoutMs?: number;
}

export class SupervisorAgent {
  private openai: OpenAI;
  private toolExecutor: ToolExecutor;
  private state: SupervisorState;
  private events: SupervisorAgentEvents;
  private workerExecutor?: (tasks: WorkerTask[], signal?: AbortSignal) => Promise<WorkerTaskResult[]>;
  private noToolResponseCount = 0;
  private consecutiveErrorCount = 0;
  private abortController: AbortController;
  private timeoutMs: number;

  constructor(options: SupervisorAgentOptions) {
    this.events = options.events ?? {};
    this.workerExecutor = options.workerExecutor;
    this.abortController = new AbortController();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;

    // Initialize OpenAI client - try Copilot API first, then direct OpenAI
    const openaiConfig = getOpenAIConfig();
    if (!openaiConfig) {
      throw new Error('APIキーが設定されていません。設定画面でOpenAI APIキーまたはGitHubトークン（Copilot API用）を設定してください。');
    }

    this.openai = new OpenAI({
      apiKey: openaiConfig.apiKey,
      baseURL: openaiConfig.baseUrl,
    });

    // Initialize state - use the runId passed from caller
    const runId = options.runId;
    this.state = {
      run_id: runId,
      phase: 'init',
      user_goal: options.userGoal,
      repo_path: options.repoPath,
      messages: [],
      active_tasks: new Map(),
      completed_tasks: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // Initialize tool executor
    this.toolExecutor = new ToolExecutor({
      repoPath: options.repoPath,
      runId,
    });

    // Set up worker executor for async tasks
    if (this.workerExecutor) {
      this.toolExecutor.setWorkerExecutor(this.workerExecutor);
    }

    // Set up callbacks for state tracking
    this.toolExecutor.setCallbacks({
      onWorkerStart: (task) => {
        this.state.active_tasks.set(task.task_id, task);
        this.state.updated_at = new Date().toISOString();
        this.events.onWorkerStart?.(task);
        this.events.onStateChange?.(this.state);
      },
      onWorkerComplete: (result) => {
        this.state.active_tasks.delete(result.task_id);
        this.state.completed_tasks.push(result);
        this.state.updated_at = new Date().toISOString();
        this.events.onWorkerComplete?.(result);
        this.events.onStateChange?.(this.state);
      },
      onCancel: () => {
        this.state.phase = 'failed';
        this.state.error = 'Run cancelled';
        this.state.updated_at = new Date().toISOString();
        this.events.onStateChange?.(this.state);
      },
    });

    logger.info('Supervisor Agent initialized', {
      runId,
      repoPath: options.repoPath,
      userGoal: options.userGoal.slice(0, 100),
    });
  }

  /**
   * Run the Supervisor Agent until completion or failure
   */
  async run(): Promise<SupervisorState> {
    this.updatePhase('planning');

    // Set up overall timeout
    const timeoutId = setTimeout(() => {
      logger.warn('Agent timeout reached', {
        runId: this.state.run_id,
        timeoutMs: this.timeoutMs,
      });
      this.abortController.abort();
    }, this.timeoutMs);

    try {
      // Add system and user messages
      this.addMessage({
        role: 'system',
        content: SUPERVISOR_SYSTEM_PROMPT,
      });
      this.addMessage({
        role: 'user',
        content: `ユーザーの目標: ${this.state.user_goal}\n\nリポジトリパス: ${this.state.repo_path}\n\nこの目標を達成してください。`,
      });

      // Main agent loop - runs until complete or fail
      while (
        this.state.phase !== 'completed' &&
        this.state.phase !== 'failed' &&
        !this.abortController.signal.aborted
      ) {
        logger.info('Supervisor step', {
          runId: this.state.run_id,
          phase: this.state.phase,
        });

        try {
          await this.step();
          // Reset consecutive error count on successful step
          this.consecutiveErrorCount = 0;
        } catch (error) {
          this.consecutiveErrorCount++;
          const errorMsg = getErrorMessage(error);
          logger.error('Supervisor step failed', {
            runId: this.state.run_id,
            error: errorMsg,
            consecutiveErrors: this.consecutiveErrorCount,
          });

          // Check if we've exceeded max consecutive errors
          if (this.consecutiveErrorCount >= MAX_CONSECUTIVE_ERRORS) {
            logger.error('Max consecutive errors reached, failing', {
              runId: this.state.run_id,
              count: this.consecutiveErrorCount,
            });
            this.state.phase = 'failed';
            this.state.error = `連続${MAX_CONSECUTIVE_ERRORS}回エラーが発生したため終了: ${errorMsg}`;
            break;
          }

          // Add error to messages
          this.addMessage({
            role: 'user',
            content: `エラーが発生しました (${this.consecutiveErrorCount}/${MAX_CONSECUTIVE_ERRORS}): ${errorMsg}\n\n回復可能であれば続行、不可能であればfailを呼んでください。`,
          });
        }
      }

      // Handle timeout
      if (this.abortController.signal.aborted && this.state.phase !== 'completed') {
        this.state.phase = 'failed';
        this.state.error = `タイムアウト (${Math.round(this.timeoutMs / 60000)}分) に達しました`;
      }
    } finally {
      clearTimeout(timeoutId);
    }

    return this.state;
  }

  /**
   * Cancel the running agent
   */
  cancel(reason?: string): void {
    logger.info('Agent cancelled', { runId: this.state.run_id, reason });
    this.abortController.abort();
    this.state.phase = 'failed';
    this.state.error = reason ?? 'Cancelled by user';
    this.state.updated_at = new Date().toISOString();
    this.events.onStateChange?.(this.state);
  }

  /**
   * Restart the agent from failed/completed state
   * Preserves conversation history and continues execution
   */
  async restart(): Promise<SupervisorState> {
    // Only allow restart from terminal states
    if (!this.canRestart()) {
      logger.warn('Cannot restart agent that is not in terminal state', {
        runId: this.state.run_id,
        phase: this.state.phase,
      });
      return this.state;
    }

    logger.info('Restarting agent', {
      runId: this.state.run_id,
      previousPhase: this.state.phase,
      previousError: this.state.error,
    });

    // Reset state for restart
    this.abortController = new AbortController();
    this.consecutiveErrorCount = 0;
    this.noToolResponseCount = 0;
    this.state.phase = 'dispatching';
    this.state.error = undefined;
    this.state.updated_at = new Date().toISOString();

    // Add restart message to conversation
    this.addMessage({
      role: 'user',
      content: '[システム: エージェントが再開されました。前回の状態を確認し、未完了のタスクがあれば続行してください。完了していればcomplete()を呼んでください。]',
    });

    this.events.onStateChange?.(this.state);

    // Set up overall timeout
    const timeoutId = setTimeout(() => {
      logger.warn('Agent timeout reached', {
        runId: this.state.run_id,
        timeoutMs: this.timeoutMs,
      });
      this.abortController.abort();
    }, this.timeoutMs);

    try {
      // Resume main agent loop - use isTerminal() to avoid TypeScript narrowing issues
      while (!this.isTerminal() && !this.abortController.signal.aborted) {
        logger.info('Supervisor step (restart)', {
          runId: this.state.run_id,
          phase: this.state.phase,
        });

        try {
          await this.step();
          this.consecutiveErrorCount = 0;
        } catch (error) {
          this.consecutiveErrorCount++;
          const errorMsg = getErrorMessage(error);
          logger.error('Supervisor step failed', {
            runId: this.state.run_id,
            error: errorMsg,
            consecutiveErrors: this.consecutiveErrorCount,
          });

          if (this.consecutiveErrorCount >= MAX_CONSECUTIVE_ERRORS) {
            logger.error('Max consecutive errors reached, failing', {
              runId: this.state.run_id,
              count: this.consecutiveErrorCount,
            });
            this.state.phase = 'failed';
            this.state.error = `連続${MAX_CONSECUTIVE_ERRORS}回エラーが発生したため終了: ${errorMsg}`;
            break;
          }

          this.addMessage({
            role: 'user',
            content: `エラーが発生しました (${this.consecutiveErrorCount}/${MAX_CONSECUTIVE_ERRORS}): ${errorMsg}\n\n回復可能であれば続行、不可能であればfailを呼んでください。`,
          });
        }
      }

      if (this.abortController.signal.aborted && !this.isCompleted()) {
        this.state.phase = 'failed';
        this.state.error = `タイムアウト (${Math.round(this.timeoutMs / 60000)}分) に達しました`;
      }
    } finally {
      clearTimeout(timeoutId);
    }

    return this.state;
  }

  /**
   * Check if agent is in terminal state (completed or failed)
   */
  private isTerminal(): boolean {
    return this.state.phase === 'completed' || this.state.phase === 'failed';
  }

  /**
   * Check if agent completed successfully
   */
  private isCompleted(): boolean {
    return this.state.phase === 'completed';
  }

  /**
   * Check if agent can be restarted
   */
  canRestart(): boolean {
    return this.state.phase === 'failed' || this.state.phase === 'completed';
  }

  /**
   * Manage context length by summarizing old messages if needed
   * Triggers on both token count and message count
   */
  private async manageContextLength(): Promise<void> {
    let summarizationAttempts = 0;
    const maxContextTokens = getMaxContextTokens();

    while (summarizationAttempts < MAX_SUMMARIZATION_ATTEMPTS) {
      const totalTokens = this.state.messages.reduce(
        (sum, m) => sum + countTokens(m.content),
        0
      );

      const messageCount = this.state.messages.length;
      const needsSummarization = totalTokens > maxContextTokens ||
        messageCount > MAX_MESSAGES_BEFORE_SUMMARIZATION;

      if (!needsSummarization) {
        return; // Context is within limits
      }

      summarizationAttempts++;
      logger.info('Context length exceeded, summarizing old messages', {
        runId: this.state.run_id,
        totalTokens,
        maxTokens: maxContextTokens,
        attempt: summarizationAttempts,
      });

      // Keep system message and last N messages (reduce on subsequent attempts)
      const keepRecentCount = Math.max(5, 20 - (summarizationAttempts - 1) * 5);
      // System message is always at index 0 if it exists - O(1) instead of O(n) find
      const firstMsg = this.state.messages[0];
      const systemMessage = firstMsg?.role === 'system' ? firstMsg : undefined;
      const recentMessages = this.state.messages.slice(-keepRecentCount);
      const oldMessages = this.state.messages.slice(
        systemMessage ? 1 : 0,
        -keepRecentCount
      );

      if (oldMessages.length === 0) {
        // Nothing left to summarize, truncate recent messages if still too long
        logger.warn('No old messages to summarize, context may be too long', {
          runId: this.state.run_id,
          totalTokens,
        });
        return;
      }

      // Create summary of old messages
      const summary = await this.summarizeMessages(oldMessages);

      this.state.messages = [
        ...(systemMessage ? [systemMessage] : []),
        {
          role: 'user' as const,
          content: `[これまでの会話の要約]\n${summary}\n\n[要約ここまで - 以下は最近の会話です]`,
        },
        ...recentMessages.filter(m => m.role !== 'system'),
      ];

      logger.info('Context summarized', {
        runId: this.state.run_id,
        summarizedMessages: oldMessages.length,
        remainingMessages: this.state.messages.length,
        attempt: summarizationAttempts,
      });
    }

    // If we've reached max attempts and still over limit, log warning
    const finalTokens = this.state.messages.reduce(
      (sum, m) => sum + countTokens(m.content),
      0
    );
    if (finalTokens > maxContextTokens) {
      logger.warn('Context still exceeds limit after max summarization attempts', {
        runId: this.state.run_id,
        finalTokens,
        maxTokens: maxContextTokens,
      });
    }
  }

  /**
   * Summarize a list of messages using the LLM
   */
  private async summarizeMessages(messages: SupervisorMessage[]): Promise<string> {
    const model = getDAGModel();

    // Build content to summarize
    const content = messages.map(m => {
      const role = m.role === 'assistant' ? 'Supervisor' : m.role === 'tool' ? 'Tool Result' : 'User';
      const text = m.content.slice(0, 500); // Truncate long messages for summary
      return `[${role}]: ${text}`;
    }).join('\n\n');

    try {
      const response = await this.openai.chat.completions.create({
        model,
        messages: [
          {
            role: 'system',
            content: 'あなたは会話要約アシスタントです。与えられた会話履歴を簡潔に要約してください。重要な決定事項、実行されたタスク、発生したエラー、現在の状態を含めてください。',
          },
          {
            role: 'user',
            content: `以下の会話を要約してください:\n\n${content}`,
          },
        ],
        max_tokens: 1000,
      });

      return response.choices[0]?.message?.content ?? '(要約を生成できませんでした)';
    } catch (error) {
      logger.error('Failed to summarize messages', {
        runId: this.state.run_id,
        error: getErrorMessage(error),
      });
      // Fallback to simple summary
      return `${messages.length}件のメッセージを要約できませんでした。実行されたWorkerタスク数: ${this.state.completed_tasks.length}`;
    }
  }

  /**
   * Call OpenAI API with retry logic
   */
  private async callOpenAIWithRetry(
    messages: OpenAI.ChatCompletionMessageParam[],
    model: string
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_API_RETRIES; attempt++) {
      try {
        const response = await this.openai.chat.completions.create({
          model,
          messages,
          tools: SUPERVISOR_TOOLS.map((t) => ({
            type: t.type as 'function',
            function: {
              name: t.function.name,
              description: t.function.description,
              parameters: t.function.parameters as OpenAI.FunctionParameters,
            },
          })),
          tool_choice: 'auto',
        });
        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (!checkRetryableError(error) || attempt === MAX_API_RETRIES - 1) {
          throw lastError;
        }

        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
        logger.warn('API call failed, retrying', {
          runId: this.state.run_id,
          attempt: attempt + 1,
          maxRetries: MAX_API_RETRIES,
          delay,
          error: lastError.message,
        });

        await sleep(delay);
      }
    }

    throw lastError ?? new Error('API call failed');
  }

  /**
   * Execute one step of the agent loop
   */
  private async step(): Promise<void> {
    // Manage context length before API call
    await this.manageContextLength();

    // Get model from settings
    const model = getDAGModel();

    // Convert messages to proper OpenAI format
    const messages: OpenAI.ChatCompletionMessageParam[] = this.state.messages
      .filter((m) => {
        // Filter out tool messages without valid tool_call_id
        if (m.role === 'tool' && !m.tool_call_id) {
          logger.warn('Skipping tool message without tool_call_id', {
            runId: this.state.run_id,
          });
          return false;
        }
        return true;
      })
      .map((m) => {
        if (m.role === 'system') {
          return { role: 'system' as const, content: m.content };
        } else if (m.role === 'user') {
          return { role: 'user' as const, content: m.content };
        } else if (m.role === 'tool') {
          return {
            role: 'tool' as const,
            content: m.content,
            tool_call_id: m.tool_call_id!, // Already filtered above
          };
        } else {
          // assistant
          return {
            role: 'assistant' as const,
            content: m.content,
            tool_calls: m.tool_calls?.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: tc.function,
            })),
          };
        }
      });

    logger.debug('Calling OpenAI API', {
      runId: this.state.run_id,
      model,
      messageCount: messages.length,
    });

    // Call API with retry
    const response = await this.callOpenAIWithRetry(messages, model);

    const choice = response.choices[0];
    if (!choice?.message) {
      throw new Error('No response from model');
    }

    // Check finish_reason
    if (choice.finish_reason === 'length') {
      logger.warn('Response truncated due to token limit', {
        runId: this.state.run_id,
      });
      // Add message to inform the LLM
      this.addMessage({
        role: 'user',
        content: '[システム: 前回の応答がトークン制限で切れました。簡潔に続けてください。]',
      });
      return;
    }

    if (choice.finish_reason === 'content_filter') {
      logger.warn('Response blocked by content filter', {
        runId: this.state.run_id,
      });
      this.addMessage({
        role: 'user',
        content: '[システム: コンテンツフィルターにより応答がブロックされました。別のアプローチを試してください。]',
      });
      return;
    }

    const assistantMessage = choice.message;

    // Log thinking
    if (assistantMessage.content) {
      this.events.onThinking?.(assistantMessage.content);
      logger.debug('Supervisor thinking', {
        runId: this.state.run_id,
        content: assistantMessage.content.slice(0, 200),
      });
    }

    // Add assistant message to history
    this.addMessage({
      role: 'assistant',
      content: assistantMessage.content || '',
      tool_calls: assistantMessage.tool_calls?.map((tc: OpenAI.Chat.Completions.ChatCompletionMessageToolCall) => ({
        id: tc.id,
        type: tc.type,
        function: tc.function,
      })),
    });

    // Execute tool calls if any
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      this.noToolResponseCount = 0;  // Reset counter
      await this.executeToolCalls(assistantMessage.tool_calls);
    } else {
      // No tool calls - LLM just responded with text
      this.noToolResponseCount++;

      if (this.noToolResponseCount >= MAX_NO_TOOL_RESPONSES) {
        logger.warn('Multiple responses without tool calls', {
          runId: this.state.run_id,
          count: this.noToolResponseCount,
        });

        // Remind the LLM to use tools
        this.addMessage({
          role: 'user',
          content: `[システム: ${this.noToolResponseCount}回連続でツールが呼ばれていません。タスクを進めるにはツールを使用してください。完了した場合はcomplete()を、問題がある場合はfail()を呼んでください。]`,
        });
      }
    }
  }

  /**
   * Execute tool calls from the assistant (in parallel for better performance)
   */
  private async executeToolCalls(
    toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[]
  ): Promise<void> {
    // Execute all tool calls in parallel
    const executeOne = async (toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall) => {
      const name = toolCall.function.name;
      let args: Record<string, unknown>;

      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        args = {};
      }

      logger.info('Executing tool', {
        runId: this.state.run_id,
        tool: name,
        args,
      });

      const result = await this.toolExecutor.execute(name, args);
      return { toolCall, result };
    };

    // Run all tool executions in parallel
    const settled = await Promise.allSettled(toolCalls.map(executeOne));

    // Process results in order (to maintain consistent message ordering)
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]!;
      if (outcome.status === 'fulfilled') {
        const { toolCall, result } = outcome.value;

        // Handle special actions (run control)
        if (result.success && result.result) {
          const actionResult = result.result as {
            action?: string;
            summary?: string;
            reason?: string;
          };

          if (actionResult.action === 'complete') {
            this.state.phase = 'completed';
            this.state.final_summary = actionResult.summary;
          } else if (actionResult.action === 'fail') {
            this.state.phase = 'failed';
            this.state.error = actionResult.reason;
          } else if (actionResult.action === 'cancel') {
            this.state.phase = 'failed';
            this.state.error = `Cancelled: ${actionResult.reason}`;
          }
        }

        // Add tool result to messages
        const toolResultContent = result.success
          ? JSON.stringify(result.result, null, 2)
          : `Error: ${result.error}`;

        this.addMessage({
          role: 'tool',
          content: toolResultContent,
          tool_call_id: toolCall.id,
        });
      } else {
        // Promise was rejected (unexpected error) - use index directly (O(1) instead of indexOf O(n))
        const toolCall = toolCalls[i]!;
        this.addMessage({
          role: 'tool',
          content: `Error: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
          tool_call_id: toolCall.id,
        });
      }
    }
  }

  /**
   * Add a message to the conversation history
   * Enforces message limits to prevent memory exhaustion
   */
  private addMessage(message: SupervisorMessage): void {
    // Check hard limit - drop oldest non-system messages if exceeded
    if (this.state.messages.length >= MAX_MESSAGES_HARD_LIMIT) {
      logger.warn('Message hard limit reached, dropping old messages', {
        runId: this.state.run_id,
        messageCount: this.state.messages.length,
      });
      // Keep system message and drop oldest messages
      // System message is always at index 0 if it exists - O(1) instead of O(n) find
      const firstMsg = this.state.messages[0];
      const systemMessage = firstMsg?.role === 'system' ? firstMsg : undefined;
      const recentMessages = this.state.messages.slice(-Math.floor(MAX_MESSAGES_HARD_LIMIT / 2));
      this.state.messages = systemMessage
        ? [systemMessage, ...recentMessages.filter(m => m.role !== 'system')]
        : recentMessages;
    }

    this.state.messages.push(message);
    this.state.updated_at = new Date().toISOString();
    this.events.onStateChange?.(this.state);
  }

  /**
   * Update the current phase
   */
  private updatePhase(phase: SupervisorState['phase']): void {
    this.state.phase = phase;
    this.state.updated_at = new Date().toISOString();
    this.events.onStateChange?.(this.state);

    logger.info('Phase changed', {
      runId: this.state.run_id,
      phase,
    });
  }

  /**
   * Get current state
   */
  getState(): SupervisorState {
    return { ...this.state };
  }

  /**
   * Get run ID
   */
  getRunId(): string {
    return this.state.run_id;
  }
}

// =============================================================================
// Factory Function
// =============================================================================

export function createSupervisorAgent(options: SupervisorAgentOptions): SupervisorAgent {
  return new SupervisorAgent(options);
}
