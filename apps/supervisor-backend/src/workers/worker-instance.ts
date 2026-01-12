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

    // Create appropriate adapter
    if (config.executorType === 'codex') {
      this.adapter = createCodexAdapter({ sandbox: true });
    } else {
      this.adapter = createClaudeAdapter({
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
          eventLog(this.config.runId, 'info', 'codex', `Result: ${preview}`, {
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
      this.worker.avg_task_duration_ms = durationMs;

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
      const errorMsg = error instanceof Error ? error.message : String(error);

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
      const limitedContext = context.repoContext.length > CONTEXT_TRUNCATION_LIMIT
        ? context.repoContext.slice(0, CONTEXT_TRUNCATION_LIMIT) + '\n\n... (truncated)'
        : context.repoContext;
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
    logger.debug('Worker disposed', {
      workerId: this.worker.worker_id,
      completedTasks: this.worker.completed_tasks,
      failedTasks: this.worker.failed_tasks,
    });
  }

  /**
   * Forward agent messages to event bus
   */
  private forwardAgentMessage(message: ClaudeAgentMessage, taskId: string): void {
    const source = this.config.executorType === 'claude' ? 'claude' : 'codex';

    // Type-safe message handling based on discriminated union
    if (message.type === 'system') {
      const content = 'message' in message ? message.message : undefined;
      const subtype = 'subtype' in message ? message.subtype : undefined;
      if (content) {
        eventLog(this.config.runId, 'info', source, `[${subtype ?? 'system'}] ${content}`, {
          task_id: taskId,
          worker_id: this.worker.worker_id,
        });
      }
    }

    // Log assistant text messages
    if (message.type === 'assistant') {
      const content = 'content' in message ? message.content : undefined;
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
    }

    // Log result messages
    if (message.type === 'result') {
      const result = 'result' in message ? message.result : undefined;
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
  }
}

/**
 * Create a new worker instance
 */
export function createWorkerInstance(config: WorkerInstanceConfig): WorkerInstance {
  return new WorkerInstance(config);
}
