/**
 * API client for Supervisor backend
 */

// Always use relative paths - Vite dev server proxies to backend
// In production, the built client is served by the backend itself
const API_BASE = '';

export interface PlanTask {
  id: string;
  name: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  dependencies?: string[];
}

export interface Plan {
  id: string;
  status: 'draft' | 'pending_approval' | 'approved' | 'rejected';
  tasks: PlanTask[];
  created_at: string;
  updated_at: string;
}

export interface Run {
  run_id: string;
  status: string;
  user_goal: string;
  created_at: string;
  updated_at: string;
  verification_passed?: boolean;
  error?: string;
  final_report?: string;
  plan?: Plan;
}

export interface RunList {
  runs: Run[];
  total: number;
}

export interface LogEntry {
  runId: string;
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  source: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface UsageStats {
  available: boolean;
  usage?: {
    premium_requests: {
      used: number;
      limit: number;
      reset_at: string;
    };
  };
  recommendation: string;
}

// Project types - simplified, specs are managed as files in the repo
export interface Project {
  project_id: string;
  name: string;
  description?: string;
  repo_path: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectList {
  projects: Project[];
  total: number;
}

// Runs API
export async function fetchRuns(): Promise<RunList> {
  const res = await fetch(`${API_BASE}/api/runs`);
  if (!res.ok) throw new Error('Failed to fetch runs');
  return res.json();
}

export async function fetchRun(runId: string): Promise<Run> {
  const res = await fetch(`${API_BASE}/api/runs/${runId}`);
  if (!res.ok) throw new Error('Failed to fetch run');
  return res.json();
}

export interface CreateRunOptions {
  goal: string;
  repoPath: string;
  projectId?: string;
}

export async function createRun(
  goalOrOptions: string | CreateRunOptions,
  repoPath?: string
): Promise<{ run_id: string }> {
  const options: CreateRunOptions = typeof goalOrOptions === 'string'
    ? { goal: goalOrOptions, repoPath: repoPath! }
    : goalOrOptions;

  const res = await fetch(`${API_BASE}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      goal: options.goal,
      repo_path: options.repoPath,
      project_id: options.projectId,
    }),
  });
  if (!res.ok) throw new Error('Failed to create run');
  return res.json();
}

export async function deleteRun(runId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/runs/${runId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete run');
}

export async function fetchRunReport(runId: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/runs/${runId}/report`);
  if (!res.ok) throw new Error('Failed to fetch report');
  return res.text();
}

// Projects API
export async function fetchProjects(): Promise<ProjectList> {
  const res = await fetch(`${API_BASE}/api/projects`);
  if (!res.ok) throw new Error('Failed to fetch projects');
  return res.json();
}

export async function fetchProject(projectId: string): Promise<Project> {
  const res = await fetch(`${API_BASE}/api/projects/${projectId}`);
  if (!res.ok) throw new Error('Failed to fetch project');
  return res.json();
}

export async function createProject(data: {
  name: string;
  description?: string;
  repo_path: string;
}): Promise<Project> {
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to create project');
  return res.json();
}

export async function updateProject(
  projectId: string,
  data: Partial<Omit<Project, 'project_id' | 'created_at' | 'updated_at'>>
): Promise<Project> {
  const res = await fetch(`${API_BASE}/api/projects/${projectId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to update project');
  return res.json();
}

export async function deleteProject(projectId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete project');
}

// Logs API
export async function fetchLogs(runId: string, since?: string): Promise<{ logs: LogEntry[] }> {
  const url = new URL(`${API_BASE}/api/logs/${runId}`, window.location.origin);
  if (since) url.searchParams.set('since', since);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error('Failed to fetch logs');
  return res.json();
}

// Usage API
export async function fetchUsage(): Promise<UsageStats> {
  const res = await fetch(`${API_BASE}/api/usage`);
  if (!res.ok) throw new Error('Failed to fetch usage');
  return res.json();
}

// DAG types
export interface DAGNode {
  task_id: string;
  name: string;
  description: string;
  dependencies: string[];
  executor_preference: 'codex' | 'claude' | 'any';
  priority: number;
  status: 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'cancelled';
  assigned_worker_id?: string;
  started_at?: string;
  completed_at?: string;
  error?: string;
}

export interface DAGProgress {
  total: number;
  completed: number;
  failed: number;
  running: number;
  ready: number;
  pending: number;
  percentage: number;
}

export interface DAG {
  dag_id: string;
  run_id: string;
  nodes: DAGNode[];
  edges: Array<{ from: string; to: string }>;
  progress: DAGProgress;
  created_at: string;
  updated_at: string;
}

// Worker types
export interface Worker {
  worker_id: string;
  executor_type: 'codex' | 'claude';
  status: 'idle' | 'busy' | 'error' | 'shutdown' | 'starting';
  current_task_id?: string;
  created_at: string;
  completed_tasks: number;
  failed_tasks: number;
  avg_task_duration_ms?: number;
}

export interface WorkerPoolStatus {
  total_workers: number;
  idle_workers: number;
  busy_workers: number;
  error_workers: number;
  workers: Worker[];
  total_tasks_completed: number;
  total_tasks_failed: number;
}

// DAG API
export async function fetchDAG(runId: string): Promise<DAG | null> {
  const res = await fetch(`${API_BASE}/api/runs/${runId}/dag`);
  if (res.status === 404 || res.status === 202) return null;
  if (!res.ok) throw new Error('Failed to fetch DAG');
  return res.json();
}

// Workers API
export async function fetchWorkerPool(runId: string): Promise<WorkerPoolStatus | null> {
  const res = await fetch(`${API_BASE}/api/runs/${runId}/workers`);
  if (res.status === 404 || res.status === 202) return null;
  if (!res.ok) throw new Error('Failed to fetch worker pool');
  return res.json();
}

// Health API
export async function fetchHealth(): Promise<{ status: string; version: string }> {
  const res = await fetch(`${API_BASE}/health`);
  if (!res.ok) throw new Error('Failed to fetch health');
  return res.json();
}

// SSE for logs
export function subscribeToLogs(
  runId: string | null,
  onMessage: (data: LogEntry) => void,
  onError?: (error: Event) => void
): () => void {
  const url = new URL(`${API_BASE}/api/events`, window.location.origin);
  if (runId) url.searchParams.set('run_id', runId);

  const eventSource = new EventSource(url.toString());

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type !== 'connected') {
        onMessage(data);
      }
    } catch (e) {
      console.error('Failed to parse SSE message:', e);
    }
  };

  eventSource.onerror = (error) => {
    console.error('SSE error:', error);
    onError?.(error);
  };

  return () => eventSource.close();
}

// Plan API
export async function fetchPlan(runId: string): Promise<Plan | null> {
  const res = await fetch(`${API_BASE}/api/runs/${runId}/plan`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Failed to fetch plan');
  return res.json();
}

export async function savePlan(runId: string, plan: Omit<Plan, 'id' | 'created_at' | 'updated_at'>): Promise<Plan> {
  const res = await fetch(`${API_BASE}/api/runs/${runId}/plan`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(plan),
  });
  if (!res.ok) throw new Error('Failed to save plan');
  return res.json();
}

export async function approvePlan(runId: string): Promise<Plan> {
  const res = await fetch(`${API_BASE}/api/runs/${runId}/plan/approve`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to approve plan');
  return res.json();
}

export async function rejectPlan(runId: string): Promise<Plan> {
  const res = await fetch(`${API_BASE}/api/runs/${runId}/plan/reject`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to reject plan');
  return res.json();
}

export async function generatePlanWithAI(runId: string): Promise<Plan> {
  const res = await fetch(`${API_BASE}/api/runs/${runId}/plan/generate`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to generate plan');
  return res.json();
}

// Settings types
export interface AppSettings {
  openai_api_key?: string;
  anthropic_api_key?: string;
  default_model?: string;
  openai_api_key_set?: boolean;
  anthropic_api_key_set?: boolean;
  // Copilot API settings
  copilot_api_url?: string;
  github_token?: string;
  github_token_set?: boolean;
  use_copilot_api?: boolean;
  // DAG building model (for LangGraph)
  dag_model?: string;
}

// Copilot API status
export interface CopilotAPIStatus {
  running: boolean;
  pid?: number;
  url?: string;
  error?: string;
  startedAt?: string;
  enabled: boolean;
  configured_url: string;
  healthy: boolean;
}

// Settings API
export async function fetchSettings(): Promise<AppSettings> {
  const res = await fetch(`${API_BASE}/api/settings`);
  if (!res.ok) throw new Error('Failed to fetch settings');
  return res.json();
}

export async function updateSettings(settings: Partial<AppSettings>): Promise<AppSettings> {
  const res = await fetch(`${API_BASE}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error('Failed to update settings');
  return res.json();
}

export async function deleteSetting(key: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/settings/${key}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete setting');
}

// Copilot API management
export async function fetchCopilotStatus(): Promise<CopilotAPIStatus> {
  const res = await fetch(`${API_BASE}/api/copilot/status`);
  if (!res.ok) throw new Error('Failed to fetch copilot status');
  return res.json();
}

export async function startCopilotAPI(): Promise<CopilotAPIStatus> {
  const res = await fetch(`${API_BASE}/api/copilot/start`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to start copilot-api');
  return res.json();
}

export async function stopCopilotAPI(): Promise<CopilotAPIStatus> {
  const res = await fetch(`${API_BASE}/api/copilot/stop`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to stop copilot-api');
  return res.json();
}

export async function restartCopilotAPI(): Promise<CopilotAPIStatus> {
  const res = await fetch(`${API_BASE}/api/copilot/restart`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to restart copilot-api');
  return res.json();
}

// Copilot Models
export interface CopilotModel {
  id: string;
  object: string;
  created?: number;
  owned_by?: string;
}

export async function fetchCopilotModels(): Promise<{ models: CopilotModel[] }> {
  const res = await fetch(`${API_BASE}/api/copilot/models`);
  if (!res.ok) throw new Error('Failed to fetch copilot models');
  return res.json();
}
