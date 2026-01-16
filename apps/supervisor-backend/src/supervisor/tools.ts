/**
 * Supervisor Tools
 * Tools available to the Supervisor Agent for orchestrating work
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, lstatSync, realpathSync } from 'node:fs';
import { join, relative, dirname, resolve, normalize } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';

const execAsync = promisify(exec);
import type { ToolDefinition, WorkerTask, WorkerTaskResult } from './types.js';
import { createTaskId } from '@supervisor/protocol';
import { logger } from '../services/logger.js';
import { getErrorMessage, ToolExecutionError } from '../services/errors.js';

// =============================================================================
// Constants (configurable via environment variables)
// =============================================================================

/** Maximum file size to read (50KB) */
const MAX_FILE_READ_SIZE = parseInt(process.env['TOOLS_MAX_FILE_READ_SIZE'] ?? '50000', 10);

/** Maximum command output size (100KB) */
const MAX_COMMAND_OUTPUT_SIZE = parseInt(process.env['TOOLS_MAX_COMMAND_OUTPUT_SIZE'] ?? '100000', 10);

/** Maximum number of files to list */
const MAX_LIST_FILES = parseInt(process.env['TOOLS_MAX_LIST_FILES'] ?? '500', 10);

/** Maximum directory depth for recursive listing */
const MAX_LIST_DEPTH = parseInt(process.env['TOOLS_MAX_LIST_DEPTH'] ?? '10', 10);

/** Maximum output log lines to keep per task */
const MAX_OUTPUT_LOG_LINES = parseInt(process.env['TOOLS_MAX_OUTPUT_LOG_LINES'] ?? '1000', 10);

/** Command timeout in milliseconds (5 minutes) */
const COMMAND_TIMEOUT_MS = parseInt(process.env['TOOLS_COMMAND_TIMEOUT_MS'] ?? '300000', 10);

/** Command max buffer size (10MB) */
const COMMAND_MAX_BUFFER = parseInt(process.env['TOOLS_COMMAND_MAX_BUFFER'] ?? String(10 * 1024 * 1024), 10);

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
 * Uses realpath to resolve symlinks and prevent symlink-based attacks
 */
function validatePath(rootPath: string, relativePath: string): { valid: boolean; fullPath: string; error?: string } {
  // Check for null bytes and other dangerous characters
  if (relativePath.includes('\0')) {
    return {
      valid: false,
      fullPath: '',
      error: 'Path contains null byte',
    };
  }

  // Check for other potentially dangerous patterns
  if (/[\x00-\x1f\x7f]/.test(relativePath)) {
    return {
      valid: false,
      fullPath: '',
      error: 'Path contains control characters',
    };
  }

  // Check for Windows UNC path attacks
  const isWindows = process.platform === 'win32';
  if (isWindows && (relativePath.startsWith('\\\\') || relativePath.startsWith('//'))) {
    return {
      valid: false,
      fullPath: '',
      error: 'UNC paths are not allowed',
    };
  }

  // Check for Windows drive letter escapes
  if (isWindows && /^[a-zA-Z]:/.test(relativePath)) {
    return {
      valid: false,
      fullPath: '',
      error: 'Absolute paths with drive letters are not allowed',
    };
  }

  let normalizedRoot: string;
  try {
    // Use realpath to resolve any symlinks in the root path itself
    normalizedRoot = existsSync(rootPath) ? realpathSync(rootPath) : resolve(rootPath);
  } catch {
    normalizedRoot = resolve(rootPath);
  }

  const fullPath = resolve(normalizedRoot, relativePath);
  let normalizedFull = normalize(fullPath);

  // Check if the resolved path starts with the root (case-insensitive on Windows)
  const rootCheck = isWindows ? normalizedRoot.toLowerCase() : normalizedRoot;
  let fullCheck = isWindows ? normalizedFull.toLowerCase() : normalizedFull;

  if (!fullCheck.startsWith(rootCheck)) {
    return {
      valid: false,
      fullPath: '',
      error: `Path traversal detected: ${relativePath} resolves outside repository`,
    };
  }

  // If the path exists, also check the realpath to prevent symlink attacks
  if (existsSync(fullPath)) {
    try {
      const realFullPath = realpathSync(fullPath);
      normalizedFull = realFullPath;
      fullCheck = isWindows ? realFullPath.toLowerCase() : realFullPath;

      if (!fullCheck.startsWith(rootCheck)) {
        return {
          valid: false,
          fullPath: '',
          error: `Symlink escape detected: ${relativePath} resolves outside repository via symlink`,
        };
      }
    } catch {
      // realpath failed, likely due to permissions - allow the operation to proceed
      // and let the actual file operation fail if needed
    }
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
 * Dangerous command patterns that should be blocked
 * These patterns are designed to be comprehensive and prevent bypass attempts
 */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Destructive file operations on root or system directories
  // Handles various forms: rm -rf /, rm -rf /*, rm -rf ~
  { pattern: /\brm\s+(-[rRfFiIdDvV]+\s*)*[/\\]($|\s|"|\*)/i, reason: 'Deleting root directory' },
  { pattern: /\brm\s+(-[rRfFiIdDvV]+\s*)*~($|\s|\/)/i, reason: 'Deleting home directory' },
  { pattern: /\brm\s+(-[rRfFiIdDvV]+\s*)*\$HOME($|\s|\/)/i, reason: 'Deleting home directory' },

  // System file access - also handle escaped paths
  { pattern: /[/\\]etc[/\\](passwd|shadow|sudoers|gshadow)/i, reason: 'Accessing system authentication files' },
  { pattern: /[/\\]etc[/\\]ssh[/\\]/i, reason: 'Accessing SSH configuration' },
  { pattern: /[/\\]\.ssh[/\\]/i, reason: 'Accessing SSH directory' },
  { pattern: /[/\\]proc[/\\]/i, reason: 'Accessing /proc filesystem' },
  { pattern: /[/\\]sys[/\\]class/i, reason: 'Accessing /sys filesystem' },

  // Environment and credential exfiltration - handle various quoting styles
  { pattern: /\b(printenv|env)\s*(\|\||&&|\||;|\$\(|`)/i, reason: 'Piping environment variables' },
  { pattern: /\$\{?[A-Z_]*PASSWORD\}?/i, reason: 'Accessing password variables' },
  { pattern: /\$\{?[A-Z_]*SECRET\}?/i, reason: 'Accessing secret variables' },
  { pattern: /\$\{?[A-Z_]*API_KEY\}?/i, reason: 'Accessing API key variables' },
  { pattern: /\$\{?[A-Z_]*TOKEN\}?/i, reason: 'Accessing token variables' },
  { pattern: /\$\{?[A-Z_]*PRIVATE\}?/i, reason: 'Accessing private key variables' },
  { pattern: /\$\{?[A-Z_]*CREDENTIAL\}?/i, reason: 'Accessing credential variables' },

  // Network exfiltration attempts
  { pattern: /\bcurl\s+.*(-d|--data|--data-raw|--data-binary|--data-urlencode)\s*['"$`]/i, reason: 'Potential data exfiltration via curl' },
  { pattern: /\bwget\s+.*--post-(data|file)/i, reason: 'Exfiltrating data via wget' },
  { pattern: /\bnc\s+.*-[a-z]*e/i, reason: 'Netcat with execute flag (reverse shell)' },
  { pattern: /\bnetcat\s+.*-[a-z]*e/i, reason: 'Netcat with execute flag (reverse shell)' },
  { pattern: /\bncat\s+.*-[a-z]*e/i, reason: 'Ncat with execute flag (reverse shell)' },
  { pattern: /\bsocat\s+/i, reason: 'Socat (potential reverse shell)' },
  { pattern: /\bbash\s+-i\s+/i, reason: 'Interactive bash (potential reverse shell)' },
  { pattern: />\s*[/\\]dev[/\\]tcp[/\\]/i, reason: 'Bash TCP redirect (reverse shell)' },

  // Dangerous shell features
  { pattern: /\beval\s+.*(\$\(|`)/i, reason: 'Dangerous eval with command substitution' },
  { pattern: /`[^`]*\$\([^)]*\)[^`]*`/i, reason: 'Nested command substitution (potential injection)' },
  { pattern: /\bsource\s+[/\\]dev[/\\]/i, reason: 'Sourcing from /dev' },
  { pattern: /\bbash\s+-c\s+.*base64/i, reason: 'Base64 encoded command execution' },
  { pattern: /\becho\s+.*\|\s*base64\s+-d\s*\|/i, reason: 'Base64 decode piped to execution' },

  // Privilege escalation
  { pattern: /\bchmod\s+[0-7]*[67][0-7]*\s+[/\\]/i, reason: 'Modifying system permissions' },
  { pattern: /\bchown\s+.*[/\\](bin|sbin|usr|etc|lib)/i, reason: 'Changing system file ownership' },
  { pattern: /\bsetcap\s+/i, reason: 'Setting Linux capabilities' },
  { pattern: /\bsetfacl\s+/i, reason: 'Modifying filesystem ACLs' },

  // Process killing (only block system-wide kills)
  { pattern: /\bkill\s+(-[a-zA-Z0-9]+\s+)*-1($|\s)/i, reason: 'Killing all processes' },
  { pattern: /\bkillall\s+-[a-zA-Z0-9]*9/i, reason: 'Force killing processes by name' },
  { pattern: /\bpkill\s+-[a-zA-Z0-9]*9/i, reason: 'Force killing processes by pattern' },

  // Dangerous redirects and file descriptors
  { pattern: />\s*[/\\]dev[/\\]sd[a-z]/i, reason: 'Direct write to block device' },
  { pattern: /dd\s+.*of=[/\\]dev[/\\]sd/i, reason: 'dd write to block device' },
  { pattern: /mkfs\s+/i, reason: 'Formatting filesystem' },

  // Cron and scheduled task manipulation
  { pattern: /crontab\s+-(r|e)/i, reason: 'Modifying crontab' },
  { pattern: /\bat\s+/i, reason: 'Scheduling commands with at' },

  // Service and system control
  { pattern: /\bsystemctl\s+(stop|disable|mask)\s+/i, reason: 'Stopping/disabling system services' },
  { pattern: /\bservice\s+\w+\s+stop/i, reason: 'Stopping system services' },
  { pattern: /\bshutdown\s+/i, reason: 'System shutdown' },
  { pattern: /\breboot\s*/i, reason: 'System reboot' },
  { pattern: /\binit\s+[0-6]/i, reason: 'Changing runlevel' },
];

/**
 * Interactive commands that may hang
 */
const INTERACTIVE_PATTERNS: RegExp[] = [
  /\bsudo\s/,    // sudo might prompt for password
  /\bpasswd\b/,  // password change
  /\bvi\b/,      // vi editor
  /\bvim\b/,     // vim editor
  /\bnano\b/,    // nano editor
  /\bemacs\b/,   // emacs editor
  /\bssh\s/,     // SSH connection
  /\btelnet\s/,  // Telnet connection
];

/**
 * Commands that should be logged for security audit
 */
const AUDIT_PATTERNS: RegExp[] = [
  /\bcurl\s/,    // HTTP requests
  /\bwget\s/,    // HTTP downloads
  /\bgit\s+push/,// Git push
  /\bnpm\s+publish/, // npm publish
  /\bdocker\s/,  // Docker commands
];

/**
 * Validate command for shell execution
 * Blocks dangerous patterns and warns about potentially problematic commands
 */
function validateCommand(command: string): { valid: boolean; error?: string; warnings?: string[] } {
  const warnings: string[] = [];

  // Reject empty commands
  if (!command || command.trim().length === 0) {
    return { valid: false, error: 'Command cannot be empty' };
  }

  // Check for dangerous patterns
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      logger.warn('Dangerous command blocked', { command: command.slice(0, 100), reason });
      return { valid: false, error: `Security: ${reason}` };
    }
  }

  // Check for interactive commands (use exec() once instead of test() then match())
  for (const pattern of INTERACTIVE_PATTERNS) {
    const match = pattern.exec(command);
    if (match) {
      warnings.push(`Command may require interactive input: ${match[0]}`);
      logger.warn('Command may require interactive input', { command: command.slice(0, 50) });
    }
  }

  // Log commands for security audit
  for (const pattern of AUDIT_PATTERNS) {
    if (pattern.test(command)) {
      logger.info('Audit: Command executed', { command: command.slice(0, 100) });
    }
  }

  return { valid: true, warnings: warnings.length > 0 ? warnings : undefined };
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
          replace_all: {
            type: 'boolean',
            description: 'trueの場合は全ての出現箇所を置換、falseまたは省略時は最初の1つのみ置換（デフォルト: false）',
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

/** Maximum file size for writes (10MB) */
const MAX_FILE_WRITE_SIZE = 10 * 1024 * 1024;

/**
 * Async mutex with timeout support for protecting critical sections
 * Prevents deadlocks through timeout mechanism
 * Uses Map for O(1) removal on timeout
 */
class AsyncMutex {
  private locked = false;
  /** Queue using Map for O(1) deletion on timeout */
  private queue = new Map<number, {
    resolve: () => void;
    reject: (err: Error) => void;
    timeoutId: NodeJS.Timeout;
  }>();
  private nextId = 0;
  private static readonly DEFAULT_TIMEOUT_MS = 30000; // 30 seconds

  async acquire(timeoutMs = AsyncMutex.DEFAULT_TIMEOUT_MS): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const id = this.nextId++;
      const timeoutId = setTimeout(() => {
        // Remove from queue on timeout (O(1) operation)
        this.queue.delete(id);
        reject(new Error(`Mutex acquire timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      this.queue.set(id, { resolve, reject, timeoutId });
    });
  }

  release(): void {
    // Get first (oldest) entry from the Map
    const firstEntry = this.queue.entries().next();
    if (!firstEntry.done) {
      const [id, item] = firstEntry.value;
      this.queue.delete(id);
      clearTimeout(item.timeoutId);
      item.resolve();
    } else {
      this.locked = false;
    }
  }

  async withLock<T>(fn: () => T | Promise<T>, timeoutMs?: number): Promise<T> {
    await this.acquire(timeoutMs);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /**
   * Check if mutex is currently locked (for debugging)
   */
  isLocked(): boolean {
    return this.locked;
  }

  /**
   * Get queue length (for debugging/monitoring)
   */
  getQueueLength(): number {
    return this.queue.size;
  }
}

export class ToolExecutor {
  private asyncTasks: Map<string, AsyncTask> = new Map();
  private tasksMutex = new AsyncMutex();
  private workerExecutor?: (tasks: WorkerTask[], signal?: AbortSignal) => Promise<WorkerTaskResult[]>;
  private callbacks: ToolExecutorCallbacks = {};
  private cancelled = false;

  constructor(private ctx: ToolExecutorContext) {}

  /**
   * Set the worker executor function
   */
  setWorkerExecutor(executor: (tasks: WorkerTask[], signal?: AbortSignal) => Promise<WorkerTaskResult[]>): void {
    console.log('[DEBUG] setWorkerExecutor: Worker executor configured');
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
   * Optimized: single pass to collect, sort once, bulk delete
   */
  private cleanupOldTasks(): void {
    // Collect only non-running tasks (completed/failed)
    const completedEntries: Array<[string, string]> = [];
    for (const [taskId, task] of this.asyncTasks) {
      if (task.status !== 'running') {
        completedEntries.push([taskId, task.completedAt ?? '']);
      }
    }

    // Only proceed if over limit
    if (completedEntries.length <= MAX_COMPLETED_TASKS) {
      return;
    }

    // Sort by completedAt (ascending - oldest first)
    completedEntries.sort((a, b) => a[1].localeCompare(b[1]));

    // Calculate how many to remove and delete them
    const toRemoveCount = completedEntries.length - MAX_COMPLETED_TASKS;
    for (let i = 0; i < toRemoveCount; i++) {
      this.asyncTasks.delete(completedEntries[i]![0]);
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
            replace_all: { type: 'boolean' },
          });
          if (!v.valid) return { success: false, error: v.error };
          return this.editFile(
            v.validated.path as string,
            v.validated.old_string as string,
            v.validated.new_string as string,
            (v.validated.replace_all as boolean) ?? false
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
          return await this.runCommand(v.validated.command as string);
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
      const errorMsg = getErrorMessage(error);
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
      const truncated = content.length > MAX_FILE_READ_SIZE
        ? content.slice(0, MAX_FILE_READ_SIZE) + `\n\n... (truncated, showing ${MAX_FILE_READ_SIZE} of ${content.length} chars)`
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

  private editFile(path: string, oldString: string, newString: string, replaceAll = false): ToolResult {
    // Validate path to prevent traversal
    const pathCheck = validatePath(this.ctx.repoPath, path);
    if (!pathCheck.valid) {
      return { success: false, error: pathCheck.error };
    }

    // Check file size limit to prevent disk exhaustion
    if (newString.length > MAX_FILE_WRITE_SIZE) {
      return {
        success: false,
        error: `Content too large: ${newString.length} bytes (max: ${MAX_FILE_WRITE_SIZE} bytes)`,
      };
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

      // Count total occurrences
      const escapedOldString = oldString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const totalOccurrences = (content.match(new RegExp(escapedOldString, 'g')) || []).length;

      // Replace based on replaceAll flag
      let newContent: string;
      let replacements: number;

      if (replaceAll) {
        // Replace all occurrences
        newContent = content.replaceAll(oldString, newString);
        replacements = totalOccurrences;
      } else {
        // Replace only the first occurrence
        newContent = content.replace(oldString, newString);
        replacements = 1;
      }

      writeFileSync(pathCheck.fullPath, newContent, 'utf-8');

      return {
        success: true,
        result: {
          action: 'edited',
          path,
          replacements,
          total_occurrences: totalOccurrences,
          replace_all: replaceAll,
        },
      };
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

      const walk = (dir: string, depth: number) => {
        if (files.length >= MAX_LIST_FILES) return;
        if (depth > MAX_LIST_DEPTH) return;

        const entries = readdirSync(dir);
        for (const entry of entries) {
          if (files.length >= MAX_LIST_FILES) break;

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
    console.log('[DEBUG] spawnWorkers called', { taskCount: tasks.length, hasWorkerExecutor: !!this.workerExecutor });
    if (!this.workerExecutor) {
      console.error('[DEBUG] spawnWorkers: Worker executor NOT configured!');
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
      const errorMsg = getErrorMessage(error);
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
    console.log('[DEBUG] spawnWorkersAsync called', { taskCount: tasks.length, hasWorkerExecutor: !!this.workerExecutor });
    if (!this.workerExecutor) {
      console.error('[DEBUG] spawnWorkersAsync: Worker executor NOT configured!');
      return { success: false, error: 'Worker executor not configured' };
    }

    // Check if run is being cancelled
    if (this.cancelled) {
      return { success: false, error: 'Run is being cancelled, cannot spawn new workers' };
    }

    const taskIds: string[] = [];

    // Create tasks with output callbacks
    const workerTasks: WorkerTask[] = tasks.map(task => {
      const taskId = createTaskId();
      return {
        task_id: taskId,
        instruction: task.instruction,
        executor: task.executor,
        context: task.context,
        priority: 5,
        created_at: new Date().toISOString(),
        // Output callback to capture logs for get_task_output
        onOutput: (output: string) => {
          this.addTaskOutput(taskId, output);
        },
      };
    });

    for (const task of workerTasks) {
      const abortController = new AbortController();

      // Notify worker start
      this.callbacks.onWorkerStart?.(task);

      const promise: Promise<WorkerTaskResult> = this.workerExecutor([task], abortController.signal)
        .then(results => {
          const result = results[0];
          // Use mutex for thread-safe access
          return this.tasksMutex.withLock(() => {
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
          });
        })
        .catch(error => {
          // Use mutex for thread-safe access
          return this.tasksMutex.withLock(() => {
            const asyncTask = this.asyncTasks.get(task.task_id);
            if (asyncTask && asyncTask.status === 'running') {
              asyncTask.status = 'failed';
              asyncTask.error = getErrorMessage(error);
              asyncTask.completedAt = new Date().toISOString();
            }
            // Don't re-throw - let the error be captured in asyncTask
            return {
              task_id: task.task_id,
              instruction: task.instruction,
              executor: task.executor,
              success: false,
              error: getErrorMessage(error),
              duration_ms: 0,
              completed_at: new Date().toISOString(),
            };
          });
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

    // Wait for all running tasks in parallel
    const waitPromises = idsToWait.map(async (id) => {
      const asyncTask = this.asyncTasks.get(id);
      if (!asyncTask) {
        return { task_id: id, status: 'not_found' as const };
      }

      if (asyncTask.status === 'running') {
        // Wait for completion
        await asyncTask.promise;
      }

      // Get the final result
      return {
        task_id: id,
        status: asyncTask.status,
        success: asyncTask.result?.success,
        summary: asyncTask.result?.summary,
        error: asyncTask.error ?? asyncTask.result?.error,
      };
    });

    // Wait for all tasks in parallel
    const results = await Promise.all(waitPromises);

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
   * Optimized: uses loop instead of spread, batch-trims only when 20% over limit
   */
  addTaskOutput(taskId: string, output: string): void {
    const asyncTask = this.asyncTasks.get(taskId);
    if (asyncTask) {
      // Split by lines and add (loop instead of spread to avoid O(n) spread cost)
      const lines = output.split('\n');
      for (const line of lines) {
        asyncTask.outputLogs.push(line);
      }
      // Batch-trim: only splice when significantly over limit (20%) to reduce O(n) operations
      const trimThreshold = Math.floor(MAX_OUTPUT_LOG_LINES * 1.2);
      if (asyncTask.outputLogs.length > trimThreshold) {
        const excess = asyncTask.outputLogs.length - MAX_OUTPUT_LOG_LINES;
        asyncTask.outputLogs.splice(0, excess);
      }
    }
  }

  // ===========================================================================
  // Command Execution
  // ===========================================================================

  private async runCommand(command: string): Promise<ToolResult> {
    // Validate command
    const cmdCheck = validateCommand(command);
    if (!cmdCheck.valid) {
      return { success: false, error: cmdCheck.error };
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.ctx.repoPath,
        maxBuffer: COMMAND_MAX_BUFFER,
        timeout: COMMAND_TIMEOUT_MS,
        shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      });

      return {
        success: true,
        result: {
          stdout: stdout.slice(0, MAX_COMMAND_OUTPUT_SIZE),
          stderr: stderr ? stderr.slice(0, MAX_COMMAND_OUTPUT_SIZE / 2) : undefined,
          exit_code: 0,
        },
      };
    } catch (error) {
      const execError = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean; signal?: string };
      if (execError.killed || execError.signal === 'SIGTERM') {
        return { success: false, error: `Command timed out after ${Math.round(COMMAND_TIMEOUT_MS / 60000)} minutes` };
      }
      return {
        success: false,
        error: `Command failed (exit ${execError.code}): ${execError.stderr || execError.stdout}`.slice(0, MAX_COMMAND_OUTPUT_SIZE / 2),
      };
    }
  }

  // ===========================================================================
  // Run Control
  // ===========================================================================

  private complete(summary: string): ToolResult {
    // Clean up all async tasks on run completion
    this.clearAllTasks();
    return {
      success: true,
      result: {
        action: 'complete',
        summary,
      },
    };
  }

  private fail(reason: string): ToolResult {
    // Clean up all async tasks on run failure
    this.clearAllTasks();
    return {
      success: true,
      result: {
        action: 'fail',
        reason,
      },
    };
  }

  private cancel(reason: string): ToolResult {
    // Set cancelled flag to prevent new tasks from being spawned
    this.cancelled = true;

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

    // Clear all tasks after cancellation
    this.asyncTasks.clear();

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

  /**
   * Clear all tasks (called on run completion)
   */
  clearAllTasks(): void {
    // Cancel any running tasks first
    for (const [, asyncTask] of this.asyncTasks) {
      if (asyncTask.status === 'running') {
        asyncTask.abortController.abort();
      }
    }
    this.asyncTasks.clear();
  }
}
