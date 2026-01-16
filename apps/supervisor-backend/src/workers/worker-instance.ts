/**
 * WorkerInstance - An executor instance (Codex or Claude)
 * Workers can be reused across multiple tasks
 */

import type {
  Worker,
  WorkerExecutorType,
  WorkOrder,
  WorkReport,
  DAGNode,
  DAG,
} from '@supervisor/protocol';
import { createWorkerId, createWorkOrderId, LOG_PREVIEW_LENGTH, CONTEXT_TRUNCATION_LIMIT } from '@supervisor/protocol';
import { createCodexAdapter, type CodexAdapter, type CodexExecutionOptions, type CodexEvent } from '@supervisor/executor-codex';
import { createClaudeAdapter, type ClaudeAdapter, type ClaudeExecutionOptions, type ClaudeAgentMessage } from '@supervisor/executor-claude';
import { log as eventLog } from '../services/event-bus.js';
import { logger } from '../services/logger.js';
import { getErrorMessage } from '../services/errors.js';
import { getClaudeModel, getCodexModel } from '../services/settings-store.js';

/** Unified execution options for both adapters */
type ExecutionOptions = ClaudeExecutionOptions | CodexExecutionOptions;

export interface WorkerInstanceConfig {
  executorType: WorkerExecutorType;
  repoPath: string;
  runId: string;
}

export interface TaskContext {
  userGoal: string;
  repoContext?: string;
  dag?: DAG;
  completedTasks?: Record<string, string>; // taskId -> summary
}

export interface TaskExecutionResult {
  success: boolean;
  report?: WorkReport;
  error?: string;
  durationMs: number;
}

type ExecutorAdapter = CodexAdapter | ClaudeAdapter;

export class WorkerInstance {
  private worker: Worker;
  private adapter: ExecutorAdapter;
  private config: WorkerInstanceConfig;

  constructor(config: WorkerInstanceConfig) {
    this.config = config;
    const now = new Date().toISOString();

    this.worker = {
      worker_id: createWorkerId(),
      executor_type: config.executorType,
      status: 'idle',
      created_at: now,
      completed_tasks: 0,
      failed_tasks: 0,
    };

    // Create appropriate adapter with model from settings
    if (config.executorType === 'codex') {
      this.adapter = createCodexAdapter({
        model: getCodexModel(),
        sandbox: true,
      });
    } else {
      this.adapter = createClaudeAdapter({
        model: getClaudeModel(),
        maxTurns: 50,
        permissionMode: 'acceptEdits',
      });
    }
  }

  /**
   * Check if executor is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      return await this.adapter.isAvailable();
    } catch {
      return false;
    }
  }

  /**
   * Execute a DAG task - this is the main entry point
   * Worker can be reused for multiple tasks
   */
  async executeTask(node: DAGNode, context?: TaskContext): Promise<TaskExecutionResult> {
    const startTime = Date.now();
    this.worker.status = 'running';
    this.worker.current_task_id = node.task_id;

    try {
      // Convert DAGNode to WorkOrder with context
      const workOrder = this.createWorkOrder(node, context);

      // Message handler to forward agent messages to event bus
      const handleClaudeMessage = (message: ClaudeAgentMessage): void => {
        this.forwardAgentMessage(message, node.task_id);
      };

      // Event handler for Codex
      const handleCodexEvent = (event: CodexEvent): void => {
        if (event.type === 'complete' && event.result) {
          const preview = event.result.length > LOG_PREVIEW_LENGTH
            ? event.result.slice(0, LOG_PREVIEW_LENGTH) + '...'
            : event.result;
          const source = this.config.executorType === 'claude' ? 'claude' : 'codex';
          eventLog(this.config.runId, 'info', source, `Result: ${preview}`, {
            task_id: node.task_id,
            worker_id: this.worker.worker_id,
          });
        }
      };

      // Build execution options based on executor type
      let executionOptions: ExecutionOptions;
      if (this.config.executorType === 'claude') {
        executionOptions = {
          cwd: this.config.repoPath,
          onMessage: handleClaudeMessage,
        } satisfies ClaudeExecutionOptions;
      } else {
        executionOptions = {
          cwd: this.config.repoPath,
          onEvent: handleCodexEvent,
        } satisfies CodexExecutionOptions;
      }

      // Execute with appropriate options
      const report = await this.adapter.execute(workOrder, executionOptions);

      const durationMs = Date.now() - startTime;

      if (report.status === 'done') {
        this.worker.status = 'idle';
        this.worker.completed_tasks++;
      } else {
        this.worker.status = 'idle';
        this.worker.failed_tasks++;
        this.worker.last_error = report.error?.message ?? report.summary;
      }

      this.worker.current_task_id = undefined;
      // Calculate proper rolling average for successful tasks only
      // Failed tasks should not count towards performance metrics
      if (report.status === 'done') {
        const completedCount = this.worker.completed_tasks;
        if (this.worker.avg_task_duration_ms === undefined || completedCount === 1) {
          this.worker.avg_task_duration_ms = durationMs;
        } else {
          // Rolling average: (old_avg * (n-1) + new_value) / n
          this.worker.avg_task_duration_ms = Math.round(
            (this.worker.avg_task_duration_ms * (completedCount - 1) + durationMs) / completedCount
          );
        }
      }

      return {
        success: report.status === 'done',
        report,
        durationMs,
        error: report.status !== 'done'
          ? (report.error?.message ?? report.summary ?? 'Task failed')
          : undefined,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMsg = getErrorMessage(error);

      this.worker.status = 'idle';
      this.worker.failed_tasks++;
      this.worker.last_error = errorMsg;
      this.worker.current_task_id = undefined;

      logger.error('Task execution failed', {
        taskId: node.task_id,
        workerId: this.worker.worker_id,
        error: errorMsg,
        durationMs,
      });

      return {
        success: false,
        error: errorMsg,
        durationMs,
      };
    }
  }

  /**
   * Convert DAGNode to WorkOrder with context
   */
  private createWorkOrder(node: DAGNode, context?: TaskContext): WorkOrder {
    const objectiveParts: string[] = [];

    if (context?.userGoal) {
      objectiveParts.push(`## Overall Goal\n${context.userGoal}`);
    }

    if (context?.repoContext) {
      let limitedContext = context.repoContext;
      if (limitedContext.length > CONTEXT_TRUNCATION_LIMIT) {
        // Find the last complete line within the limit
        const truncatedRaw = limitedContext.slice(0, CONTEXT_TRUNCATION_LIMIT);
        const lastNewline = truncatedRaw.lastIndexOf('\n');
        limitedContext = lastNewline > 0
          ? truncatedRaw.slice(0, lastNewline) + '\n\n... (truncated)'
          : truncatedRaw + '\n\n... (truncated)';
      }
      objectiveParts.push(`## Repository Context\n${limitedContext}`);
    }

    if (context?.dag) {
      const otherTasks = context.dag.nodes
        .filter(n => n.task_id !== node.task_id)
        .map(n => {
          const status = n.status === 'completed' ? '✓' : n.status === 'running' ? '▶' : '○';
          return `${status} ${n.name}`;
        })
        .join('\n');
      if (otherTasks) {
        objectiveParts.push(`## Other Tasks in This Run\n${otherTasks}`);
      }
    }

    if (context?.completedTasks && Object.keys(context.completedTasks).length > 0) {
      const completedSummary = Object.entries(context.completedTasks)
        .map(([, summary]) => `- ${summary}`)
        .join('\n');
      objectiveParts.push(`## Already Completed\n${completedSummary}`);
    }

    objectiveParts.push(`## Your Task\n**${node.name}**\n\n${node.description}`);

    const fullObjective = objectiveParts.join('\n\n---\n\n');

    return {
      order_id: createWorkOrderId(),
      run_id: this.config.runId,
      task_kind: 'implement',
      repo: {
        path: this.config.repoPath,
      },
      objective: fullObjective,
      acceptance_criteria: [
        `Complete task: ${node.name}`,
        node.description,
      ],
      verification: {
        commands: [],
      },
      tooling: {
        sandbox: true,
        approval_required: false,
        write_roots: [this.config.repoPath],
      },
      metadata: {
        priority: node.priority,
      },
    };
  }

  /**
   * Get worker info
   */
  getWorker(): Worker {
    return { ...this.worker };
  }

  /**
   * Get worker ID
   */
  getId(): string {
    return this.worker.worker_id;
  }

  /**
   * Get worker status
   */
  getStatus(): Worker['status'] {
    return this.worker.status;
  }

  /**
   * Get executor type
   */
  getExecutorType(): WorkerExecutorType {
    return this.worker.executor_type;
  }

  /**
   * Check if worker is currently running a task
   */
  isRunning(): boolean {
    return this.worker.status === 'running';
  }

  /**
   * Check if worker is idle and ready for new tasks
   */
  isIdle(): boolean {
    return this.worker.status === 'idle';
  }

  /**
   * Dispose the worker and release resources
   */
  dispose(): void {
    this.worker.status = 'completed';

    // Dispose the adapter if it has a dispose method
    if ('dispose' in this.adapter && typeof this.adapter.dispose === 'function') {
      try {
        this.adapter.dispose();
      } catch (error) {
        logger.error('Failed to dispose adapter', {
          workerId: this.worker.worker_id,
          error: getErrorMessage(error),
        });
      }
    }

    logger.debug('Worker disposed', {
      workerId: this.worker.worker_id,
      completedTasks: this.worker.completed_tasks,
      failedTasks: this.worker.failed_tasks,
    });
  }

  /**
   * Type guard for system messages
   */
  private isSystemMessage(message: ClaudeAgentMessage): message is ClaudeAgentMessage & { type: 'system'; message?: string; subtype?: string } {
    return message.type === 'system';
  }

  /**
   * Type guard for assistant messages
   */
  private isAssistantMessage(message: ClaudeAgentMessage): message is ClaudeAgentMessage & { type: 'assistant'; content?: string } {
    return message.type === 'assistant';
  }

  /**
   * Type guard for result messages
   */
  private isResultMessage(message: ClaudeAgentMessage): message is ClaudeAgentMessage & { type: 'result'; result?: string } {
    return message.type === 'result';
  }

  /**
   * Forward agent messages to event bus
   */
  private forwardAgentMessage(message: ClaudeAgentMessage, taskId: string): void {
    const source = this.config.executorType === 'claude' ? 'claude' : 'codex';

    try {
      // Type-safe message handling using type guards
      if (this.isSystemMessage(message)) {
        const content = message.message;
        const subtype = message.subtype;
        if (content) {
          eventLog(this.config.runId, 'info', source, `[${subtype ?? 'system'}] ${content}`, {
            task_id: taskId,
            worker_id: this.worker.worker_id,
          });
        }
      } else if (this.isAssistantMessage(message)) {
        const content = message.content;
        if (content) {
          // Show first 200 chars of assistant response
          const preview = content.length > LOG_PREVIEW_LENGTH
            ? content.slice(0, LOG_PREVIEW_LENGTH) + '...'
            : content;
          eventLog(this.config.runId, 'info', source, preview, {
            task_id: taskId,
            worker_id: this.worker.worker_id,
            full_content: content,
          });
        }
      } else if (this.isResultMessage(message)) {
        const result = message.result;
        if (result) {
          const preview = result.length > LOG_PREVIEW_LENGTH
            ? result.slice(0, LOG_PREVIEW_LENGTH) + '...'
            : result;
          eventLog(this.config.runId, 'info', source, `Result: ${preview}`, {
            task_id: taskId,
            worker_id: this.worker.worker_id,
          });
        }
      }
    } catch (error) {
      // Don't let message forwarding errors crash the worker
      logger.error('Failed to forward agent message', {
        taskId,
        workerId: this.worker.worker_id,
        error: getErrorMessage(error),
      });
    }
  }
}

/**
 * Create a new worker instance
 */
export function createWorkerInstance(config: WorkerInstanceConfig): WorkerInstance {
  return new WorkerInstance(config);
}
