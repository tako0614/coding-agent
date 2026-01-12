/**
 * Supervisor Tools
 * Tools available to the Supervisor Agent for orchestrating work
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import type { ToolDefinition, WorkerTask } from './types.js';
import { createTaskId } from '@supervisor/protocol';
import { logger } from '../services/logger.js';

// =============================================================================
// Tool Definitions (OpenAI Function Calling Format)
// =============================================================================

export const SUPERVISOR_TOOLS: ToolDefinition[] = [
  // ファイル操作
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'ファイルの内容を読み込む。AGENTS.mdやソースコードの確認に使用。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'リポジトリルートからの相対パス',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'ファイルを編集する。既存ファイルの一部を置換、または新規ファイル作成。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'リポジトリルートからの相対パス',
          },
          old_string: {
            type: 'string',
            description: '置換対象の文字列（新規作成時は空文字列）',
          },
          new_string: {
            type: 'string',
            description: '置換後の文字列（新規作成時はファイル全体の内容）',
          },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'ディレクトリ内のファイル一覧を取得。構造把握に使用。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'リポジトリルートからの相対パス（デフォルト: "."）',
          },
          recursive: {
            type: 'boolean',
            description: '再帰的に取得するか（デフォルト: false）',
          },
        },
        required: [],
      },
    },
  },

  // Worker管理（同期）
  {
    type: 'function',
    function: {
      name: 'spawn_workers',
      description: 'Worker Agentを起動してタスクを実行。完了まで待機する（同期実行）。',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description: '実行するタスクの配列',
            items: {
              type: 'object',
              properties: {
                instruction: {
                  type: 'string',
                  description: 'Workerへの詳細な指示',
                },
                executor: {
                  type: 'string',
                  enum: ['claude', 'codex'],
                  description: '使用するExecutor（claude: 分析・レビュー向き, codex: 実装向き）',
                },
                context: {
                  type: 'string',
                  description: '追加のコンテキスト情報（任意）',
                },
              },
              required: ['instruction', 'executor'],
            },
          },
        },
        required: ['tasks'],
      },
    },
  },

  // Worker管理（非同期）
  {
    type: 'function',
    function: {
      name: 'spawn_workers_async',
      description: 'Worker Agentを非同期で起動。完了を待たずに即座に返る。wait_workersで結果を取得。',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description: '実行するタスクの配列',
            items: {
              type: 'object',
              properties: {
                instruction: {
                  type: 'string',
                  description: 'Workerへの詳細な指示',
                },
                executor: {
                  type: 'string',
                  enum: ['claude', 'codex'],
                  description: '使用するExecutor',
                },
                context: {
                  type: 'string',
                  description: '追加のコンテキスト情報（任意）',
                },
              },
              required: ['instruction', 'executor'],
            },
          },
        },
        required: ['tasks'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait_workers',
      description: '指定したWorkerタスクの完了を待つ。task_idsを省略すると全ての実行中タスクを待つ。',
      parameters: {
        type: 'object',
        properties: {
          task_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '待機するタスクIDの配列（省略時は全タスク）',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_worker_status',
      description: 'Workerの状態を取得。実行中・完了・エラーなどを確認。',
      parameters: {
        type: 'object',
        properties: {
          task_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '確認するタスクIDの配列（省略時は全タスク）',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_worker',
      description: '指定したWorkerタスクをキャンセル。',
      parameters: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'キャンセルするタスクID',
          },
        },
        required: ['task_id'],
      },
    },
  },

  // コマンド実行
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'シェルコマンドを実行。テスト実行やビルド確認に使用。',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '実行するコマンド（npm test, npm run build 等）',
          },
        },
        required: ['command'],
      },
    },
  },

  // Run制御
  {
    type: 'function',
    function: {
      name: 'complete',
      description: 'タスク完了を宣言。全ての作業が終わったら呼び出す。',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: '完了サマリー（何を達成したか）',
          },
        },
        required: ['summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fail',
      description: 'タスク失敗を宣言。回復不能なエラーが発生した場合に呼び出す。',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: '失敗理由',
          },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel',
      description: 'Run全体をキャンセル。実行中の全Workerを停止して終了。',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'キャンセル理由',
          },
        },
        required: ['reason'],
      },
    },
  },
];

// =============================================================================
// Tool Executor
// =============================================================================

export interface ToolExecutorContext {
  repoPath: string;
  runId: string;
}

export interface ToolResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

// Async task tracking
interface AsyncTask {
  task: WorkerTask;
  promise: Promise<unknown>;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  result?: unknown;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export class ToolExecutor {
  private asyncTasks: Map<string, AsyncTask> = new Map();
  private workerExecutor?: (tasks: WorkerTask[]) => Promise<unknown[]>;
  private onCancel?: () => void;

  constructor(private ctx: ToolExecutorContext) {}

  /**
   * Set the worker executor function
   */
  setWorkerExecutor(executor: (tasks: WorkerTask[]) => Promise<unknown[]>): void {
    this.workerExecutor = executor;
  }

  /**
   * Set cancel callback
   */
  setOnCancel(callback: () => void): void {
    this.onCancel = callback;
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    logger.debug('Executing tool', { tool: name, args, runId: this.ctx.runId });

    try {
      switch (name) {
        case 'read_file':
          return this.readFile(args['path'] as string);

        case 'edit_file':
          return this.editFile(
            args['path'] as string,
            args['old_string'] as string,
            args['new_string'] as string
          );

        case 'list_files':
          return this.listFiles(
            (args['path'] as string) ?? '.',
            (args['recursive'] as boolean) ?? false
          );

        case 'spawn_workers':
          return await this.spawnWorkers(args['tasks'] as Array<{
            instruction: string;
            executor: 'claude' | 'codex';
            context?: string;
          }>);

        case 'spawn_workers_async':
          return this.spawnWorkersAsync(args['tasks'] as Array<{
            instruction: string;
            executor: 'claude' | 'codex';
            context?: string;
          }>);

        case 'wait_workers':
          return await this.waitWorkers(args['task_ids'] as string[] | undefined);

        case 'get_worker_status':
          return this.getWorkerStatus(args['task_ids'] as string[] | undefined);

        case 'cancel_worker':
          return this.cancelWorker(args['task_id'] as string);

        case 'run_command':
          return this.runCommand(args['command'] as string);

        case 'complete':
          return this.complete(args['summary'] as string);

        case 'fail':
          return this.fail(args['reason'] as string);

        case 'cancel':
          return this.cancel(args['reason'] as string);

        default:
          return { success: false, error: `Unknown tool: ${name}` };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('Tool execution failed', { tool: name, error: errorMsg });
      return { success: false, error: errorMsg };
    }
  }

  // ===========================================================================
  // File Operations
  // ===========================================================================

  private readFile(path: string): ToolResult {
    const fullPath = join(this.ctx.repoPath, path);

    if (!existsSync(fullPath)) {
      return { success: false, error: `File not found: ${path}` };
    }

    try {
      const content = readFileSync(fullPath, 'utf-8');
      const maxSize = 50000;
      const truncated = content.length > maxSize
        ? content.slice(0, maxSize) + '\n\n... (truncated)'
        : content;

      return { success: true, result: truncated };
    } catch (error) {
      return { success: false, error: `Failed to read file: ${error}` };
    }
  }

  private editFile(path: string, oldString: string, newString: string): ToolResult {
    const fullPath = join(this.ctx.repoPath, path);

    try {
      // 新規作成の場合
      if (oldString === '') {
        const dir = dirname(fullPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(fullPath, newString, 'utf-8');
        return { success: true, result: { action: 'created', path } };
      }

      // 既存ファイルの編集
      if (!existsSync(fullPath)) {
        return { success: false, error: `File not found: ${path}` };
      }

      const content = readFileSync(fullPath, 'utf-8');

      if (!content.includes(oldString)) {
        return { success: false, error: `String not found in file: "${oldString.slice(0, 50)}..."` };
      }

      const newContent = content.replace(oldString, newString);
      writeFileSync(fullPath, newContent, 'utf-8');

      return { success: true, result: { action: 'edited', path } };
    } catch (error) {
      return { success: false, error: `Failed to edit file: ${error}` };
    }
  }

  private listFiles(path: string, recursive: boolean): ToolResult {
    const fullPath = join(this.ctx.repoPath, path);

    if (!existsSync(fullPath)) {
      return { success: false, error: `Directory not found: ${path}` };
    }

    try {
      const files: string[] = [];
      const maxFiles = 500;

      const walk = (dir: string, depth: number) => {
        if (files.length >= maxFiles) return;
        if (depth > 10) return;

        const entries = readdirSync(dir);
        for (const entry of entries) {
          if (files.length >= maxFiles) break;

          if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist') {
            continue;
          }

          const entryPath = join(dir, entry);
          const relativePath = relative(this.ctx.repoPath, entryPath);
          const stat = statSync(entryPath);

          if (stat.isDirectory()) {
            files.push(relativePath + '/');
            if (recursive) {
              walk(entryPath, depth + 1);
            }
          } else {
            files.push(relativePath);
          }
        }
      };

      walk(fullPath, 0);

      return { success: true, result: files };
    } catch (error) {
      return { success: false, error: `Failed to list files: ${error}` };
    }
  }

  // ===========================================================================
  // Worker Management (Sync)
  // ===========================================================================

  private async spawnWorkers(tasks: Array<{
    instruction: string;
    executor: 'claude' | 'codex';
    context?: string;
  }>): Promise<ToolResult> {
    if (!this.workerExecutor) {
      return { success: false, error: 'Worker executor not configured' };
    }

    const workerTasks: WorkerTask[] = tasks.map(task => ({
      task_id: createTaskId(),
      instruction: task.instruction,
      executor: task.executor,
      context: task.context,
      priority: 5,
      created_at: new Date().toISOString(),
    }));

    logger.info('Spawning workers (sync)', {
      count: workerTasks.length,
      runId: this.ctx.runId,
    });

    try {
      // Execute all tasks and wait for completion
      const results = await this.workerExecutor(workerTasks);

      const taskResults = workerTasks.map((task, index) => ({
        task_id: task.task_id,
        instruction: task.instruction,
        executor: task.executor,
        result: results[index],
        status: 'completed' as const,
      }));

      return {
        success: true,
        result: {
          message: `${workerTasks.length}個のタスクが完了しました`,
          tasks: taskResults,
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('Spawn workers failed', { error: errorMsg, runId: this.ctx.runId });
      return {
        success: false,
        error: `Worker execution failed: ${errorMsg}`,
      };
    }
  }

  // ===========================================================================
  // Worker Management (Async)
  // ===========================================================================

  private spawnWorkersAsync(tasks: Array<{
    instruction: string;
    executor: 'claude' | 'codex';
    context?: string;
  }>): ToolResult {
    if (!this.workerExecutor) {
      return { success: false, error: 'Worker executor not configured' };
    }

    const workerTasks: WorkerTask[] = tasks.map(task => ({
      task_id: createTaskId(),
      instruction: task.instruction,
      executor: task.executor,
      context: task.context,
      priority: 5,
      created_at: new Date().toISOString(),
    }));

    const taskIds: string[] = [];

    for (const task of workerTasks) {
      const promise = this.workerExecutor([task]).then(results => {
        const asyncTask = this.asyncTasks.get(task.task_id);
        if (asyncTask) {
          asyncTask.status = 'completed';
          asyncTask.result = results[0];
          asyncTask.completedAt = new Date().toISOString();
        }
        return results[0];
      }).catch(error => {
        const asyncTask = this.asyncTasks.get(task.task_id);
        if (asyncTask) {
          asyncTask.status = 'failed';
          asyncTask.error = error instanceof Error ? error.message : String(error);
          asyncTask.completedAt = new Date().toISOString();
        }
        throw error;
      });

      this.asyncTasks.set(task.task_id, {
        task,
        promise,
        status: 'running',
        startedAt: new Date().toISOString(),
      });

      taskIds.push(task.task_id);
    }

    logger.info('Spawning workers (async)', {
      count: workerTasks.length,
      taskIds,
      runId: this.ctx.runId,
    });

    return {
      success: true,
      result: {
        action: 'spawn_workers_async',
        task_ids: taskIds,
        message: `${taskIds.length}個のタスクを非同期で開始しました`,
      },
    };
  }

  private async waitWorkers(taskIds?: string[]): Promise<ToolResult> {
    const idsToWait = taskIds ?? Array.from(this.asyncTasks.keys());

    if (idsToWait.length === 0) {
      return { success: true, result: { tasks: [], message: '待機するタスクがありません' } };
    }

    const results: Array<{
      task_id: string;
      status: string;
      result?: unknown;
      error?: string;
    }> = [];

    for (const id of idsToWait) {
      const asyncTask = this.asyncTasks.get(id);
      if (!asyncTask) {
        results.push({ task_id: id, status: 'not_found' });
        continue;
      }

      if (asyncTask.status === 'running') {
        try {
          await asyncTask.promise;
        } catch {
          // Error already captured in asyncTask
        }
      }

      results.push({
        task_id: id,
        status: asyncTask.status,
        result: asyncTask.result,
        error: asyncTask.error,
      });
    }

    return { success: true, result: { tasks: results } };
  }

  private getWorkerStatus(taskIds?: string[]): ToolResult {
    const idsToCheck = taskIds ?? Array.from(this.asyncTasks.keys());

    const statuses = idsToCheck.map(id => {
      const asyncTask = this.asyncTasks.get(id);
      if (!asyncTask) {
        return { task_id: id, status: 'not_found' };
      }

      return {
        task_id: id,
        status: asyncTask.status,
        instruction: asyncTask.task.instruction.slice(0, 100),
        executor: asyncTask.task.executor,
        started_at: asyncTask.startedAt,
        completed_at: asyncTask.completedAt,
        error: asyncTask.error,
      };
    });

    return { success: true, result: { tasks: statuses } };
  }

  private cancelWorker(taskId: string): ToolResult {
    const asyncTask = this.asyncTasks.get(taskId);

    if (!asyncTask) {
      return { success: false, error: `Task not found: ${taskId}` };
    }

    if (asyncTask.status !== 'running') {
      return { success: false, error: `Task is not running: ${asyncTask.status}` };
    }

    asyncTask.status = 'cancelled';
    asyncTask.completedAt = new Date().toISOString();

    logger.info('Worker cancelled', { taskId, runId: this.ctx.runId });

    return { success: true, result: { task_id: taskId, status: 'cancelled' } };
  }

  // ===========================================================================
  // Command Execution
  // ===========================================================================

  private runCommand(command: string): ToolResult {
    const allowedCommands = ['npm', 'pnpm', 'yarn', 'node', 'git', 'ls', 'cat', 'pwd', 'echo', 'mkdir', 'cp', 'mv', 'rm'];
    const firstWord = command.split(' ')[0];
    if (!allowedCommands.some(cmd => firstWord === cmd || firstWord?.endsWith('/' + cmd))) {
      return { success: false, error: `Command not allowed: ${firstWord}` };
    }

    try {
      const output = execSync(command, {
        cwd: this.ctx.repoPath,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });

      return {
        success: true,
        result: {
          stdout: output.slice(0, 10000),
          exit_code: 0,
        },
      };
    } catch (error) {
      const execError = error as { status?: number; stdout?: string; stderr?: string };
      return {
        success: false,
        error: `Command failed (exit ${execError.status}): ${execError.stderr || execError.stdout}`.slice(0, 5000),
      };
    }
  }

  // ===========================================================================
  // Run Control
  // ===========================================================================

  private complete(summary: string): ToolResult {
    return {
      success: true,
      result: {
        action: 'complete',
        summary,
      },
    };
  }

  private fail(reason: string): ToolResult {
    return {
      success: true,
      result: {
        action: 'fail',
        reason,
      },
    };
  }

  private cancel(reason: string): ToolResult {
    // Cancel all running async tasks
    for (const [taskId, asyncTask] of this.asyncTasks) {
      if (asyncTask.status === 'running') {
        asyncTask.status = 'cancelled';
        asyncTask.completedAt = new Date().toISOString();
      }
    }

    // Call cancel callback
    this.onCancel?.();

    logger.info('Run cancelled', { reason, runId: this.ctx.runId });

    return {
      success: true,
      result: {
        action: 'cancel',
        reason,
      },
    };
  }

  /**
   * Get all async tasks
   */
  getAsyncTasks(): Map<string, AsyncTask> {
    return this.asyncTasks;
  }

  /**
   * Clear completed tasks
   */
  clearCompletedTasks(): void {
    for (const [taskId, asyncTask] of this.asyncTasks) {
      if (asyncTask.status !== 'running') {
        this.asyncTasks.delete(taskId);
      }
    }
  }
}
