/**
 * Supervisor Agent Types
 */

import type { WorkReport, WorkerExecutorType } from '@supervisor/protocol';

// =============================================================================
// Supervisor State
// =============================================================================

export type SupervisorPhase =
  | 'init'           // 初期化中
  | 'planning'       // 計画中（repo読み込み、タスク決定）
  | 'dispatching'    // Worker実行中
  | 'reviewing'      // 結果レビュー中
  | 'completed'      // 完了
  | 'failed';        // 失敗

export interface SupervisorState {
  run_id: string;
  phase: SupervisorPhase;
  user_goal: string;
  repo_path: string;

  // Supervisor の思考履歴
  messages: SupervisorMessage[];

  // 現在のWorkerタスク
  active_tasks: Map<string, WorkerTask>;
  completed_tasks: WorkerTaskResult[];

  // 結果
  final_summary?: string;
  error?: string;

  // メタデータ
  created_at: string;
  updated_at: string;
}

// =============================================================================
// Messages
// =============================================================================

export interface SupervisorMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

// =============================================================================
// Worker Tasks
// =============================================================================

export interface WorkerTask {
  task_id: string;
  instruction: string;
  executor: WorkerExecutorType;
  context?: string;
  priority: number;
  created_at: string;
}

export interface WorkerTaskResult {
  task_id: string;
  instruction: string;
  executor: WorkerExecutorType;
  success: boolean;
  summary?: string;
  report?: WorkReport;
  error?: string;
  duration_ms: number;
  completed_at: string;
}

// =============================================================================
// Tool Definitions
// =============================================================================

// JSON Schema type for flexible nested structures
export interface JsonSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, JsonSchemaProperty>;
      required: string[];
    };
  };
}

// =============================================================================
// Supervisor Actions
// =============================================================================

export type SupervisorAction =
  | { type: 'spawn_workers'; tasks: WorkerTask[] }
  | { type: 'spawn_workers_async'; task_ids: string[] }
  | { type: 'wait_workers'; task_ids?: string[] }
  | { type: 'cancel_worker'; task_id: string }
  | { type: 'complete'; summary: string }
  | { type: 'fail'; error: string }
  | { type: 'cancel'; reason: string }
  | { type: 'continue' };  // もう一度考える

export interface SupervisorDecision {
  thinking: string;
  action: SupervisorAction;
}

