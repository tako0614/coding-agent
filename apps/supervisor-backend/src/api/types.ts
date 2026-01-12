/**
 * API types for OpenAI-compatible interface
 */

import { z } from 'zod';

// OpenAI-compatible Chat Completion Request
export const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
  name: z.string().optional(),
});

export const ChatCompletionRequestSchema = z.object({
  model: z.string().default('supervisor-v1'),
  messages: z.array(ChatMessageSchema),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().optional(),
  stream: z.boolean().optional().default(false),
  // Supervisor-specific extensions
  repo_path: z.string().optional(),
  run_id: z.string().optional(),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

// OpenAI-compatible Chat Completion Response
export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string;
    };
    finish_reason: 'stop' | 'length' | 'tool_calls' | null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  // Supervisor extensions
  supervisor?: {
    run_id: string;
    status: string;
    verification_passed?: boolean;
    files_modified?: string[];
  };
}

// Streaming response chunk
export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
    };
    finish_reason: 'stop' | 'length' | null;
  }>;
}

// Run management types
export const CreateRunRequestSchema = z.object({
  goal: z.string(),
  repo_path: z.string(),
  project_id: z.string().optional(),
  model_policy: z.object({
    supervisor_model: z.string().optional(),
    claude_model: z.string().optional(),
    codex_model: z.string().optional(),
  }).optional(),
  security_policy: z.object({
    sandbox_enforced: z.boolean().optional(),
    shell_allowlist: z.array(z.string()).optional(),
  }).optional(),
});

export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;

export interface RunResponse {
  run_id: string;
  project_id?: string;
  status: string;
  user_goal: string;
  created_at: string;
  updated_at: string;
  verification_passed?: boolean;
  error?: string;
  final_report?: string;
}

export interface RunListResponse {
  runs: RunResponse[];
  total: number;
}

// DAG Response types
export interface DAGNodeResponse {
  task_id: string;
  name: string;
  description: string;
  dependencies: string[];
  executor_preference: 'codex' | 'claude' | 'any';
  priority: number;
  status: string;
  assigned_worker_id?: string;
  started_at?: string;
  completed_at?: string;
  error?: string;
}

export interface DAGResponse {
  dag_id: string;
  run_id: string;
  nodes: DAGNodeResponse[];
  edges: Array<{ from: string; to: string }>;
  progress: {
    total: number;
    completed: number;
    failed: number;
    running: number;
    ready: number;
    pending: number;
    percentage: number;
  };
  created_at: string;
  updated_at: string;
}

// Worker Pool Response types
export interface WorkerResponse {
  worker_id: string;
  executor_type: 'codex' | 'claude';
  status: string;
  current_task_id?: string;
  created_at: string;
  completed_tasks: number;
  failed_tasks: number;
  avg_task_duration_ms?: number;
}

export interface WorkerPoolResponse {
  total_workers: number;
  idle_workers: number;
  busy_workers: number;
  error_workers: number;
  workers: WorkerResponse[];
  total_tasks_completed: number;
  total_tasks_failed: number;
}
