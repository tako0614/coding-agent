/**
 * WorkerInstance - A single executor instance (Codex or Claude)
 * Manages lifecycle and task execution for one worker
 */

import type {
  Worker,
  WorkerStatus,
  WorkerExecutorType,
  WorkOrder,
  WorkReport,
  DAGNode,
  DAG,
} from '@supervisor/protocol';
import { createWorkerId, createWorkOrderId } from '@supervisor/protocol';
import { createCodexAdapter, type CodexAdapter } from '@supervisor/executor-codex';
import { createClaudeAdapter, type ClaudeAdapter, type ClaudeAgentMessage } from '@supervisor/executor-claude';
import { log as eventLog } from '../services/event-bus.js';

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
  private taskDurations: number[] = [];

  constructor(config: WorkerInstanceConfig) {
    this.config = config;
    const now = new Date().toISOString();

    this.worker = {
      worker_id: createWorkerId(),
      executor_type: config.executorType,
      status: 'starting',
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
   * Initialize the worker (check adapter availability)
   */
  async initialize(): Promise<boolean> {
    try {
      console.log(`[WorkerInstance] Initializing ${this.config.executorType} worker...`);
      const available = await this.adapter.isAvailable();
      console.log(`[WorkerInstance] ${this.config.executorType} adapter available: ${available}`);
      if (available) {
        this.worker.status = 'idle';
        this.worker.idle_since = new Date().toISOString();
        return true;
      } else {
        this.worker.status = 'error';
        this.worker.last_error = 'Adapter not available';
        console.error(`[WorkerInstance] ${this.config.executorType} adapter not available`);
        return false;
      }
    } catch (error) {
      this.worker.status = 'error';
      this.worker.last_error = error instanceof Error ? error.message : String(error);
      console.error(`[WorkerInstance] ${this.config.executorType} initialization failed:`, error);
      return false;
    }
  }

  /**
   * Execute a DAG task
   */
  async executeTask(node: DAGNode, context?: TaskContext): Promise<TaskExecutionResult> {
    const startTime = Date.now();

    if (this.worker.status !== 'idle') {
      return {
        success: false,
        error: `Worker is not idle (status: ${this.worker.status})`,
        durationMs: 0,
      };
    }

    this.worker.status = 'busy';
    this.worker.current_task_id = node.task_id;

    try {
      // Convert DAGNode to WorkOrder with context
      const workOrder = this.createWorkOrder(node, context);

      // Message handler to forward agent messages to event bus
      const handleMessage = (message: ClaudeAgentMessage) => {
        this.forwardAgentMessage(message, node.task_id);
      };

      // Execute
      const report = await this.adapter.execute(workOrder, {
        cwd: this.config.repoPath,
        onMessage: this.config.executorType === 'claude' ? handleMessage : undefined,
      });

      const durationMs = Date.now() - startTime;
      this.taskDurations.push(durationMs);

      // Update worker stats
      if (report.status === 'done') {
        this.worker.completed_tasks++;
      } else {
        this.worker.failed_tasks++;
      }

      // Update average duration
      this.worker.avg_task_duration_ms =
        this.taskDurations.reduce((a, b) => a + b, 0) / this.taskDurations.length;

      // Reset to idle
      this.worker.status = 'idle';
      this.worker.current_task_id = undefined;
      this.worker.idle_since = new Date().toISOString();

      return {
        success: report.status === 'done',
        report,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      this.worker.failed_tasks++;
      this.worker.status = 'error';
      this.worker.last_error = error instanceof Error ? error.message : String(error);
      this.worker.current_task_id = undefined;

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs,
      };
    }
  }

  /**
   * Convert DAGNode to WorkOrder with context
   */
  private createWorkOrder(node: DAGNode, context?: TaskContext): WorkOrder {
    // Build a comprehensive objective with context
    const objectiveParts: string[] = [];

    // Add overall goal context
    if (context?.userGoal) {
      objectiveParts.push(`## Overall Goal\n${context.userGoal}`);
    }

    // Add repository context (AGENTS.md, etc.)
    if (context?.repoContext) {
      // Limit context to avoid token overflow
      const limitedContext = context.repoContext.length > 4000
        ? context.repoContext.slice(0, 4000) + '\n\n... (truncated)'
        : context.repoContext;
      objectiveParts.push(`## Repository Context\n${limitedContext}`);
    }

    // Add DAG overview (other tasks)
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

    // Add completed tasks summary
    if (context?.completedTasks && Object.keys(context.completedTasks).length > 0) {
      const completedSummary = Object.entries(context.completedTasks)
        .map(([, summary]) => `- ${summary}`)
        .join('\n');
      objectiveParts.push(`## Already Completed\n${completedSummary}`);
    }

    // Add the current task
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
  getStatus(): WorkerStatus {
    return this.worker.status;
  }

  /**
   * Get executor type
   */
  getExecutorType(): WorkerExecutorType {
    return this.worker.executor_type;
  }

  /**
   * Check if worker is idle
   */
  isIdle(): boolean {
    return this.worker.status === 'idle';
  }

  /**
   * Check if worker is in error state
   */
  isError(): boolean {
    return this.worker.status === 'error';
  }

  /**
   * Get idle duration in milliseconds
   */
  getIdleDuration(): number {
    if (!this.worker.idle_since || this.worker.status !== 'idle') {
      return 0;
    }
    return Date.now() - new Date(this.worker.idle_since).getTime();
  }

  /**
   * Reset error state and try to recover
   */
  async recover(): Promise<boolean> {
    if (this.worker.status !== 'error') {
      return true;
    }

    this.worker.status = 'starting';
    this.worker.last_error = undefined;

    return this.initialize();
  }

  /**
   * Shutdown the worker
   */
  shutdown(): void {
    this.worker.status = 'shutdown';
    this.worker.current_task_id = undefined;
  }

  /**
   * Forward agent messages to event bus
   */
  private forwardAgentMessage(message: ClaudeAgentMessage, taskId: string): void {
    const source = this.config.executorType === 'claude' ? 'claude' : 'codex';

    // Type guard helper
    const hasType = (msg: unknown, t: string): boolean =>
      typeof msg === 'object' && msg !== null && 'type' in msg && (msg as Record<string, unknown>)['type'] === t;

    if (hasType(message, 'system')) {
      const sysMsg = message as { subtype?: string; session_id?: string; message?: string };
      eventLog(
        this.config.runId,
        sysMsg.subtype === 'error' ? 'error' : 'info',
        source,
        `[system:${sysMsg.subtype}] ${sysMsg.message || 'initialized'}`,
        { type: 'system', subtype: sysMsg.subtype, session_id: sysMsg.session_id, task_id: taskId }
      );
    } else if (hasType(message, 'assistant')) {
      const asstMsg = message as { content: string };
      if (asstMsg.content) {
        eventLog(
          this.config.runId,
          'info',
          source,
          asstMsg.content.length > 200 ? asstMsg.content.slice(0, 200) + '...' : asstMsg.content,
          { type: 'assistant', full_content: asstMsg.content, task_id: taskId }
        );
      }
    } else if (hasType(message, 'tool_use')) {
      const toolMsg = message as { tool_use_id: string; tool_name: string; tool_input: Record<string, unknown> };
      const inputStr = JSON.stringify(toolMsg.tool_input);
      eventLog(
        this.config.runId,
        'info',
        source,
        `[tool_use] ${toolMsg.tool_name}: ${inputStr.length > 100 ? inputStr.slice(0, 100) + '...' : inputStr}`,
        { type: 'tool_use', tool_name: toolMsg.tool_name, tool_input: toolMsg.tool_input, tool_use_id: toolMsg.tool_use_id, task_id: taskId }
      );
    } else if (hasType(message, 'tool_result')) {
      const resultMsg = message as { tool_use_id: string; content: string; is_error?: boolean };
      eventLog(
        this.config.runId,
        resultMsg.is_error ? 'error' : 'info',
        source,
        `[tool_result] ${resultMsg.is_error ? 'ERROR: ' : ''}${resultMsg.content.length > 200 ? resultMsg.content.slice(0, 200) + '...' : resultMsg.content}`,
        { type: 'tool_result', tool_use_id: resultMsg.tool_use_id, is_error: resultMsg.is_error, full_content: resultMsg.content, task_id: taskId }
      );
    } else if (hasType(message, 'result')) {
      const resMsg = message as { result: string; session_id: string };
      eventLog(
        this.config.runId,
        'info',
        source,
        `[result] ${resMsg.result.length > 200 ? resMsg.result.slice(0, 200) + '...' : resMsg.result}`,
        { type: 'result', session_id: resMsg.session_id, full_result: resMsg.result, task_id: taskId }
      );
    }
  }
}

/**
 * Create a new worker instance
 */
export function createWorkerInstance(config: WorkerInstanceConfig): WorkerInstance {
  return new WorkerInstance(config);
}
