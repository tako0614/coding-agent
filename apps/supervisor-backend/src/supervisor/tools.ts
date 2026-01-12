/**
 * Supervisor Tools
 * Tools available to the Supervisor Agent for orchestrating work
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { join, relative, dirname, resolve, normalize } from 'node:path';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import type { ToolDefinition, WorkerTask, WorkerTaskResult } from './types.js';
import { createTaskId } from '@supervisor/protocol';
import { logger } from '../services/logger.js';

/** Binary file extensions to skip reading as text */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.webm',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.tar', '.gz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib',
  '.woff', '.woff2', '.ttf', '.eot',
  '.bin', '.dat', '.db', '.sqlite',
]);

// =============================================================================
// Security Utilities
// =============================================================================

/**
 * Validate that a path is within the allowed root directory (prevent path traversal)
 */
function validatePath(rootPath: string, relativePath: string): { valid: boolean; fullPath: string; error?: string } {
  const normalizedRoot = resolve(rootPath);
  const fullPath = resolve(rootPath, relativePath);
  const normalizedFull = normalize(fullPath);

  // Check if the resolved path starts with the root (case-insensitive on Windows)
  const isWindows = process.platform === 'win32';
  const rootCheck = isWindows ? normalizedRoot.toLowerCase() : normalizedRoot;
  const fullCheck = isWindows ? normalizedFull.toLowerCase() : normalizedFull;

  if (!fullCheck.startsWith(rootCheck)) {
    return {
      valid: false,
      fullPath: '',
      error: `Path traversal detected: ${relativePath} resolves outside repository`,
    };
  }

  return { valid: true, fullPath: normalizedFull };
}

/**
 * Check if a file is likely binary based on extension
 */
function isBinaryFile(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Check if a path is a symlink
 */
function isSymlink(filePath: string): boolean {
  try {
    return lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Validate tool arguments
 */
function validateArgs<T extends Record<string, unknown>>(
  args: Record<string, unknown>,
  schema: { [K in keyof T]: { type: string; required?: boolean } }
): { valid: boolean; error?: string; validated: Partial<T> } {
  const validated: Partial<T> = {};

  for (const [key, spec] of Object.entries(schema)) {
    const value = args[key];

    if (spec.required && (value === undefined || value === null)) {
      return { valid: false, error: `Missing required argument: ${key}`, validated: {} };
    }

    if (value !== undefined && value !== null) {
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      if (actualType !== spec.type) {
        return {
          valid: false,
          error: `Invalid type for ${key}: expected ${spec.type}, got ${actualType}`,
          validated: {},
        };
      }
      (validated as Record<string, unknown>)[key] = value;
    }
  }

  return { valid: true, validated };
}

/**
 * Validate command for shell execution
 * Commands are now allowed by default - only basic sanity checks
 */
function validateCommand(command: string): { valid: boolean; error?: string } {
  // Only reject completely empty commands
  if (!command || command.trim().length === 0) {
    return { valid: false, error: 'Command cannot be empty' };
  }

  // Warn about commands that might hang waiting for input
  const interactivePatterns = [
    /\bsudo\s/,    // sudo might prompt for password
    /\bpasswd\b/,  // password change
    /\bvi\b/,      // vi editor
    /\bvim\b/,     // vim editor
    /\bnano\b/,    // nano editor
    /\bemacs\b/,   // emacs editor
  ];

  for (const pattern of interactivePatterns) {
    if (pattern.test(command)) {
      logger.warn('Command may require interactive input', { command: command.slice(0, 50) });
    }
  }

  return { valid: true };
}

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
  {
    type: 'function',
    function: {
      name: 'get_task_output',
      description: '実行中のWorkerタスクの途中経過（出力ログ）を取得。タスクが長時間実行中の場合に進捗を確認するために使用。',
      parameters: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: '確認するタスクID',
          },
          tail_lines: {
            type: 'number',
            description: '取得する最新行数（デフォルト: 50）',
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

// Callbacks for state tracking
export interface ToolExecutorCallbacks {
  onWorkerStart?: (task: WorkerTask) => void;
  onWorkerComplete?: (result: WorkerTaskResult) => void;
  onCancel?: () => void;
}

// Async task tracking
interface AsyncTask {
  task: WorkerTask;
  promise: Promise<WorkerTaskResult>;
  abortController: AbortController;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  result?: WorkerTaskResult;
  error?: string;
  startedAt: string;
  completedAt?: string;
  /** Output logs for progress checking */
  outputLogs: string[];
}

/** Maximum number of completed tasks to keep in memory */
const MAX_COMPLETED_TASKS = 100;

export class ToolExecutor {
  private asyncTasks: Map<string, AsyncTask> = new Map();
  private workerExecutor?: (tasks: WorkerTask[], signal?: AbortSignal) => Promise<WorkerTaskResult[]>;
  private callbacks: ToolExecutorCallbacks = {};

  constructor(private ctx: ToolExecutorContext) {}

  /**
   * Set the worker executor function
   */
  setWorkerExecutor(executor: (tasks: WorkerTask[], signal?: AbortSignal) => Promise<WorkerTaskResult[]>): void {
    this.workerExecutor = executor;
  }

  /**
   * Set callbacks for state tracking
   */
  setCallbacks(callbacks: ToolExecutorCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * Auto-cleanup old completed tasks to prevent memory leaks
   */
  private cleanupOldTasks(): void {
    const completed = Array.from(this.asyncTasks.entries())
      .filter(([, task]) => task.status !== 'running')
      .sort((a, b) => (a[1].completedAt ?? '').localeCompare(b[1].completedAt ?? ''));

    // Keep only the most recent MAX_COMPLETED_TASKS
    while (completed.length > MAX_COMPLETED_TASKS) {
      const [taskId] = completed.shift()!;
      this.asyncTasks.delete(taskId);
    }
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    logger.debug('Executing tool', { tool: name, args, runId: this.ctx.runId });

    try {
      switch (name) {
        case 'read_file': {
          const v = validateArgs(args, { path: { type: 'string', required: true } });
          if (!v.valid) return { success: false, error: v.error };
          return this.readFile(v.validated.path as string);
        }

        case 'edit_file': {
          const v = validateArgs(args, {
            path: { type: 'string', required: true },
            old_string: { type: 'string', required: true },
            new_string: { type: 'string', required: true },
          });
          if (!v.valid) return { success: false, error: v.error };
          return this.editFile(
            v.validated.path as string,
            v.validated.old_string as string,
            v.validated.new_string as string
          );
        }

        case 'list_files': {
          const v = validateArgs(args, {
            path: { type: 'string' },
            recursive: { type: 'boolean' },
          });
          if (!v.valid) return { success: false, error: v.error };
          return this.listFiles(
            (v.validated.path as string) ?? '.',
            (v.validated.recursive as boolean) ?? false
          );
        }

        case 'spawn_workers': {
          const v = validateArgs(args, { tasks: { type: 'array', required: true } });
          if (!v.valid) return { success: false, error: v.error };
          return await this.spawnWorkers(v.validated.tasks as Array<{
            instruction: string;
            executor: 'claude' | 'codex';
            context?: string;
          }>);
        }

        case 'spawn_workers_async': {
          const v = validateArgs(args, { tasks: { type: 'array', required: true } });
          if (!v.valid) return { success: false, error: v.error };
          return this.spawnWorkersAsync(v.validated.tasks as Array<{
            instruction: string;
            executor: 'claude' | 'codex';
            context?: string;
          }>);
        }

        case 'wait_workers': {
          const v = validateArgs(args, { task_ids: { type: 'array' } });
          if (!v.valid) return { success: false, error: v.error };
          return await this.waitWorkers(v.validated.task_ids as string[] | undefined);
        }

        case 'get_worker_status': {
          const v = validateArgs(args, { task_ids: { type: 'array' } });
          if (!v.valid) return { success: false, error: v.error };
          return this.getWorkerStatus(v.validated.task_ids as string[] | undefined);
        }

        case 'cancel_worker': {
          const v = validateArgs(args, { task_id: { type: 'string', required: true } });
          if (!v.valid) return { success: false, error: v.error };
          return this.cancelWorker(v.validated.task_id as string);
        }

        case 'get_task_output': {
          const v = validateArgs(args, {
            task_id: { type: 'string', required: true },
            tail_lines: { type: 'number' },
          });
          if (!v.valid) return { success: false, error: v.error };
          return this.getTaskOutput(
            v.validated.task_id as string,
            (v.validated.tail_lines as number) ?? 50
          );
        }

        case 'run_command': {
          const v = validateArgs(args, { command: { type: 'string', required: true } });
          if (!v.valid) return { success: false, error: v.error };
          return this.runCommand(v.validated.command as string);
        }

        case 'complete': {
          const v = validateArgs(args, { summary: { type: 'string', required: true } });
          if (!v.valid) return { success: false, error: v.error };
          return this.complete(v.validated.summary as string);
        }

        case 'fail': {
          const v = validateArgs(args, { reason: { type: 'string', required: true } });
          if (!v.valid) return { success: false, error: v.error };
          return this.fail(v.validated.reason as string);
        }

        case 'cancel': {
          const v = validateArgs(args, { reason: { type: 'string', required: true } });
          if (!v.valid) return { success: false, error: v.error };
          return this.cancel(v.validated.reason as string);
        }

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
    // Validate path to prevent traversal
    const pathCheck = validatePath(this.ctx.repoPath, path);
    if (!pathCheck.valid) {
      return { success: false, error: pathCheck.error };
    }

    if (!existsSync(pathCheck.fullPath)) {
      return { success: false, error: `File not found: ${path}` };
    }

    // Check for symlink
    if (isSymlink(pathCheck.fullPath)) {
      return { success: false, error: `Cannot read symlink: ${path}` };
    }

    // Check for binary file
    if (isBinaryFile(pathCheck.fullPath)) {
      const stat = statSync(pathCheck.fullPath);
      return {
        success: true,
        result: `[Binary file: ${path}, size: ${stat.size} bytes]`,
      };
    }

    try {
      const content = readFileSync(pathCheck.fullPath, 'utf-8');
      const maxSize = 50000;
      const truncated = content.length > maxSize
        ? content.slice(0, maxSize) + '\n\n... (truncated)'
        : content;

      return { success: true, result: truncated };
    } catch (error) {
      // Might be binary despite extension check
      const stat = statSync(pathCheck.fullPath);
      if (stat.size > 0) {
        return {
          success: true,
          result: `[Unreadable file (possibly binary): ${path}, size: ${stat.size} bytes]`,
        };
      }
      return { success: false, error: `Failed to read file: ${error}` };
    }
  }

  private editFile(path: string, oldString: string, newString: string): ToolResult {
    // Validate path to prevent traversal
    const pathCheck = validatePath(this.ctx.repoPath, path);
    if (!pathCheck.valid) {
      return { success: false, error: pathCheck.error };
    }

    try {
      // 新規作成の場合
      if (oldString === '') {
        const dir = dirname(pathCheck.fullPath);
        // Also validate directory path
        const dirCheck = validatePath(this.ctx.repoPath, relative(this.ctx.repoPath, dir));
        if (!dirCheck.valid) {
          return { success: false, error: dirCheck.error };
        }

        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(pathCheck.fullPath, newString, 'utf-8');
        return { success: true, result: { action: 'created', path } };
      }

      // 既存ファイルの編集
      if (!existsSync(pathCheck.fullPath)) {
        return { success: false, error: `File not found: ${path}` };
      }

      const content = readFileSync(pathCheck.fullPath, 'utf-8');

      if (!content.includes(oldString)) {
        return { success: false, error: `String not found in file: "${oldString.slice(0, 50)}..."` };
      }

      // Count replacements BEFORE replacing
      const escapedOldString = oldString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const replacements = (content.match(new RegExp(escapedOldString, 'g')) || []).length;

      // Use replaceAll to replace all occurrences
      const newContent = content.replaceAll(oldString, newString);
      writeFileSync(pathCheck.fullPath, newContent, 'utf-8');

      return { success: true, result: { action: 'edited', path, replacements } };
    } catch (error) {
      return { success: false, error: `Failed to edit file: ${error}` };
    }
  }

  private listFiles(path: string, recursive: boolean): ToolResult {
    // Validate path to prevent traversal
    const pathCheck = validatePath(this.ctx.repoPath, path);
    if (!pathCheck.valid) {
      return { success: false, error: pathCheck.error };
    }

    if (!existsSync(pathCheck.fullPath)) {
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

          // Use lstatSync to not follow symlinks
          const stat = lstatSync(entryPath);

          // Skip symlinks for security
          if (stat.isSymbolicLink()) {
            files.push(relativePath + ' -> [symlink]');
            continue;
          }

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

      walk(pathCheck.fullPath, 0);

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

    // Notify worker start
    for (const task of workerTasks) {
      this.callbacks.onWorkerStart?.(task);
    }

    try {
      // Execute all tasks and wait for completion
      const results = await this.workerExecutor(workerTasks);

      // Notify worker complete and build response
      const taskResults = workerTasks.map((task, index) => {
        const result = results[index];
        if (result) {
          this.callbacks.onWorkerComplete?.(result);
        }
        return {
          task_id: task.task_id,
          instruction: task.instruction.slice(0, 100),
          executor: task.executor,
          success: result?.success ?? false,
          summary: result?.summary,
          error: result?.error,
        };
      });

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
      const abortController = new AbortController();

      // Notify worker start
      this.callbacks.onWorkerStart?.(task);

      const promise: Promise<WorkerTaskResult> = this.workerExecutor([task], abortController.signal)
        .then(results => {
          const result = results[0];
          const asyncTask = this.asyncTasks.get(task.task_id);
          if (asyncTask && asyncTask.status === 'running') {
            asyncTask.status = 'completed';
            asyncTask.result = result;
            asyncTask.completedAt = new Date().toISOString();
            // Notify worker complete
            if (result) {
              this.callbacks.onWorkerComplete?.(result);
            }
          }
          return result ?? {
            task_id: task.task_id,
            instruction: task.instruction,
            executor: task.executor,
            success: false,
            error: 'No result returned',
            duration_ms: 0,
            completed_at: new Date().toISOString(),
          };
        })
        .catch(error => {
          const asyncTask = this.asyncTasks.get(task.task_id);
          if (asyncTask && asyncTask.status === 'running') {
            asyncTask.status = 'failed';
            asyncTask.error = error instanceof Error ? error.message : String(error);
            asyncTask.completedAt = new Date().toISOString();
          }
          // Don't re-throw - let the error be captured in asyncTask
          return {
            task_id: task.task_id,
            instruction: task.instruction,
            executor: task.executor,
            success: false,
            error: error instanceof Error ? error.message : String(error),
            duration_ms: 0,
            completed_at: new Date().toISOString(),
          };
        });

      this.asyncTasks.set(task.task_id, {
        task,
        promise,
        abortController,
        status: 'running',
        startedAt: new Date().toISOString(),
        outputLogs: [],
      });

      taskIds.push(task.task_id);
    }

    // Auto cleanup old tasks
    this.cleanupOldTasks();

    logger.info('Spawning workers (async)', {
      count: workerTasks.length,
      taskIds,
      runId: this.ctx.runId,
    });

    return {
      success: true,
      result: {
        task_ids: taskIds,
        message: `${taskIds.length}個のタスクを非同期で開始しました`,
      },
    };
  }

  private async waitWorkers(taskIds?: string[]): Promise<ToolResult> {
    // Filter to only running tasks
    const allTaskIds = Array.from(this.asyncTasks.keys());
    const runningTaskIds = allTaskIds.filter(id => this.asyncTasks.get(id)?.status === 'running');
    const idsToWait = taskIds ?? runningTaskIds;

    if (idsToWait.length === 0) {
      return { success: true, result: { tasks: [], message: '待機するタスクがありません' } };
    }

    const results: Array<{
      task_id: string;
      status: string;
      success?: boolean;
      summary?: string;
      error?: string;
    }> = [];

    for (const id of idsToWait) {
      const asyncTask = this.asyncTasks.get(id);
      if (!asyncTask) {
        results.push({ task_id: id, status: 'not_found' });
        continue;
      }

      if (asyncTask.status === 'running') {
        // Wait for completion
        await asyncTask.promise;
      }

      // Get the final result
      results.push({
        task_id: id,
        status: asyncTask.status,
        success: asyncTask.result?.success,
        summary: asyncTask.result?.summary,
        error: asyncTask.error ?? asyncTask.result?.error,
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

    // Actually abort the task
    asyncTask.abortController.abort();
    asyncTask.status = 'cancelled';
    asyncTask.completedAt = new Date().toISOString();
    asyncTask.error = 'Cancelled by user';

    logger.info('Worker cancelled', { taskId, runId: this.ctx.runId });

    return { success: true, result: { task_id: taskId, status: 'cancelled' } };
  }

  private getTaskOutput(taskId: string, tailLines: number): ToolResult {
    const asyncTask = this.asyncTasks.get(taskId);

    if (!asyncTask) {
      return { success: false, error: `Task not found: ${taskId}` };
    }

    const logs = asyncTask.outputLogs;
    const totalLines = logs.length;
    const startIndex = Math.max(0, totalLines - tailLines);
    const recentLogs = logs.slice(startIndex);

    return {
      success: true,
      result: {
        task_id: taskId,
        status: asyncTask.status,
        instruction: asyncTask.task.instruction.slice(0, 100),
        started_at: asyncTask.startedAt,
        elapsed_ms: asyncTask.completedAt
          ? new Date(asyncTask.completedAt).getTime() - new Date(asyncTask.startedAt).getTime()
          : Date.now() - new Date(asyncTask.startedAt).getTime(),
        total_log_lines: totalLines,
        showing_lines: recentLogs.length,
        output: recentLogs.join('\n'),
      },
    };
  }

  /**
   * Add output log to a task (called by worker execution)
   */
  addTaskOutput(taskId: string, output: string): void {
    const asyncTask = this.asyncTasks.get(taskId);
    if (asyncTask) {
      // Split by lines and add
      const lines = output.split('\n');
      asyncTask.outputLogs.push(...lines);
      // Keep only last 1000 lines to prevent memory issues
      if (asyncTask.outputLogs.length > 1000) {
        asyncTask.outputLogs = asyncTask.outputLogs.slice(-1000);
      }
    }
  }

  // ===========================================================================
  // Command Execution
  // ===========================================================================

  private runCommand(command: string): ToolResult {
    // Validate command
    const cmdCheck = validateCommand(command);
    if (!cmdCheck.valid) {
      return { success: false, error: cmdCheck.error };
    }

    try {
      const output = execSync(command, {
        cwd: this.ctx.repoPath,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 300000, // 5 minute timeout
        shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      });

      return {
        success: true,
        result: {
          stdout: output.slice(0, 10000),
          exit_code: 0,
        },
      };
    } catch (error) {
      const execError = error as { status?: number; stdout?: string; stderr?: string; killed?: boolean };
      if (execError.killed) {
        return { success: false, error: 'Command timed out after 5 minutes' };
      }
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
    const cancelledTaskIds: string[] = [];

    // Cancel all running async tasks (actually abort them)
    for (const [taskId, asyncTask] of this.asyncTasks) {
      if (asyncTask.status === 'running') {
        asyncTask.abortController.abort();
        asyncTask.status = 'cancelled';
        asyncTask.completedAt = new Date().toISOString();
        asyncTask.error = `Cancelled: ${reason}`;
        cancelledTaskIds.push(taskId);
      }
    }

    // Call cancel callback
    this.callbacks.onCancel?.();

    logger.info('Run cancelled', { reason, cancelledTaskIds, runId: this.ctx.runId });

    return {
      success: true,
      result: {
        action: 'cancel',
        reason,
        cancelled_tasks: cancelledTaskIds,
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
