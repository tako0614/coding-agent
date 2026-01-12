/**
 * Supervisor Agent
 * Orchestrates Worker Agents using Copilot API (GPT)
 */

import OpenAI from 'openai';
import type {
  SupervisorState,
  SupervisorMessage,
  SupervisorConfig,
  WorkerTask,
  WorkerTaskResult,
  ToolCall,
} from './types.js';
import { DEFAULT_SUPERVISOR_CONFIG } from './types.js';
import { SUPERVISOR_TOOLS, ToolExecutor } from './tools.js';
import { createRunId, createTaskId } from '@supervisor/protocol';
import { logger } from '../services/logger.js';
import { getCopilotAPIConfig, getDAGModel } from '../services/settings-store.js';

// =============================================================================
// System Prompt
// =============================================================================

const SUPERVISOR_SYSTEM_PROMPT = `あなたはSupervisor Agentです。ユーザーの目標を達成するために、Worker Agentを効率的に指揮します。

## 役割
- リポジトリ構造と仕様（AGENTS.md等）を読んで理解する
- 目標を独立したタスクに分解する
- Worker Agentに指示を出して並列実行させる
- 結果をレビューし、必要に応じて追加タスクを発行する
- 全体の完了判定を行う

## 使用可能なツール

### ファイル操作
- read_file: ファイル内容を読む
- edit_file: ファイルを編集（置換）または新規作成
- list_files: ディレクトリ構造を確認

### Worker管理（同期）
- spawn_workers: Worker起動、完了まで待機（シンプルなケース向け）

### Worker管理（非同期） ※推奨
- spawn_workers_async: Worker非同期起動（即座に返る）
- wait_workers: Workerの完了を待つ（task_ids省略で全待機）
- get_worker_status: Worker状態を確認
- cancel_worker: 特定Workerをキャンセル

### コマンド実行
- run_command: シェルコマンド実行（npm test等）

### Run制御
- complete: 全タスク完了を宣言
- fail: 失敗を宣言
- cancel: Run全体をキャンセル

## 行動指針
1. まずリポジトリ構造を確認（list_files）
2. AGENTS.mdがあれば読んで開発ルールを把握
3. タスクを独立した単位に分解
4. spawn_workers_asyncで非同期実行を開始
5. **定期的にwait_workersで結果を確認**（重要！）
6. 結果をレビューし、必要なら追加タスクを発行
7. テスト・ビルドが通ることを確認
8. 全て完了したらcompleteを呼ぶ

## 非同期Workerの使い方（重要）
1. spawn_workers_asyncでタスクを開始（task_idsが返る）
2. 他の作業（ファイル確認等）を行う、または即座にwait_workers
3. **wait_workersで結果を取得**（これを忘れない！）
4. 結果を確認し、次のアクションを決定

例:
\`\`\`
spawn_workers_async([task1, task2])  // task_ids: [id1, id2]
↓
wait_workers()  // 全タスクの完了を待つ
↓
結果を確認して次へ
\`\`\`

## executor選択
- claude: コード分析、レビュー、設計向き
- codex: 実装、コード生成向き

## 重要
- **非同期Workerを使ったら必ずwait_workersで結果を取得すること**
- Workerへの指示は具体的に（ファイルパス、期待する変更を明記）
- レビューもWorkerに任せる（executor: 'claude' を指定）
- 簡単なファイル編集はedit_fileで直接実行可能
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

export class SupervisorAgent {
  private config: SupervisorConfig;
  private openai: OpenAI;
  private toolExecutor: ToolExecutor;
  private state: SupervisorState;
  private events: SupervisorAgentEvents;
  private workerExecutor?: (tasks: WorkerTask[]) => Promise<WorkerTaskResult[]>;

  constructor(options: {
    repoPath: string;
    userGoal: string;
    config?: Partial<SupervisorConfig>;
    events?: SupervisorAgentEvents;
    workerExecutor?: (tasks: WorkerTask[]) => Promise<WorkerTaskResult[]>;
  }) {
    this.config = { ...DEFAULT_SUPERVISOR_CONFIG, ...options.config };
    this.events = options.events ?? {};
    this.workerExecutor = options.workerExecutor;

    // Initialize OpenAI client with Copilot API
    const copilotConfig = getCopilotAPIConfig();
    this.openai = new OpenAI({
      apiKey: copilotConfig.githubToken || 'copilot-proxy',
      baseURL: copilotConfig.enabled ? `${copilotConfig.baseUrl}/v1` : undefined,
    });

    // Initialize state
    const runId = createRunId();
    this.state = {
      run_id: runId,
      phase: 'init',
      user_goal: options.userGoal,
      repo_path: options.repoPath,
      messages: [],
      pending_tasks: [],
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
      this.toolExecutor.setWorkerExecutor(this.workerExecutor as (tasks: WorkerTask[]) => Promise<unknown[]>);
    }

    // Set up cancel callback
    this.toolExecutor.setOnCancel(() => {
      this.state.phase = 'failed';
      this.state.error = 'Run cancelled';
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
      this.state.phase !== 'failed'
    ) {
      logger.info('Supervisor step', {
        runId: this.state.run_id,
        phase: this.state.phase,
      });

      try {
        await this.step();
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error('Supervisor step failed', {
          runId: this.state.run_id,
          error: errorMsg,
        });

        // Add error to messages
        this.addMessage({
          role: 'user',
          content: `エラーが発生しました: ${errorMsg}\n\n回復可能であれば続行、不可能であればfailを呼んでください。`,
        });
      }
    }

    return this.state;
  }

  /**
   * Execute one step of the agent loop
   */
  private async step(): Promise<void> {
    // Get model from settings
    const model = getDAGModel();

    // Convert messages to proper OpenAI format
    const messages: OpenAI.ChatCompletionMessageParam[] = this.state.messages.map((m) => {
      if (m.role === 'system') {
        return { role: 'system' as const, content: m.content };
      } else if (m.role === 'user') {
        return { role: 'user' as const, content: m.content };
      } else if (m.role === 'tool') {
        return {
          role: 'tool' as const,
          content: m.content,
          tool_call_id: m.tool_call_id || '',
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

    const choice = response.choices[0];
    if (!choice?.message) {
      throw new Error('No response from model');
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
      await this.executeToolCalls(assistantMessage.tool_calls);
    }
  }

  /**
   * Execute tool calls from the assistant
   */
  private async executeToolCalls(
    toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[]
  ): Promise<void> {
    for (const toolCall of toolCalls) {
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
    }
  }

  /**
   * Add a message to the conversation history
   */
  private addMessage(message: SupervisorMessage): void {
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

export function createSupervisorAgent(options: {
  repoPath: string;
  userGoal: string;
  config?: Partial<SupervisorConfig>;
  events?: SupervisorAgentEvents;
  workerExecutor?: (tasks: WorkerTask[]) => Promise<WorkerTaskResult[]>;
}): SupervisorAgent {
  return new SupervisorAgent(options);
}
