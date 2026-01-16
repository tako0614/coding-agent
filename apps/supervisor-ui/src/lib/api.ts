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

export type RunMode = 'spec' | 'implementation';

export interface Run {
  run_id: string;
  project_id?: string;
  mode: RunMode;
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
  mode?: RunMode;
}

export async function createRun(
  goalOrOptions: string | CreateRunOptions,
  repoPath?: string
): Promise<{ run_id: string; mode: RunMode }> {
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
      mode: options.mode || 'implementation',
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

// Orphaned Sessions API (interrupted runs)
export interface OrphanedSession {
  run_id: string;
  first_log: string;
  last_log: string;
  log_count: number;
  first_message: string | null;
}

export async function fetchOrphanedSessions(): Promise<{ sessions: OrphanedSession[] }> {
  const res = await fetch(`${API_BASE}/api/sessions/orphaned`);
  if (!res.ok) throw new Error('Failed to fetch orphaned sessions');
  return res.json();
}

export async function deleteOrphanedSession(runId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/sessions/orphaned/${runId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete orphaned session');
}

// Parallel Sessions API
export interface ParallelSession {
  id: string;
  projectId: string | null;
  runId: string | null;
  mode: RunMode;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'interrupted';
  input: string;
  selectedModel?: string;
  executorMode?: ExecutorMode;
  terminalSessionId?: string;  // PTY session ID for reconnection
}

export async function fetchParallelSessions(): Promise<{ sessions: ParallelSession[]; version: number }> {
  const res = await fetch(`${API_BASE}/api/sessions/parallel`);
  if (!res.ok) throw new Error('Failed to fetch parallel sessions');
  return res.json();
}

export class ParallelSessionsConflictError extends Error {
  constructor() {
    super('Sessions were modified by another request');
    this.name = 'ParallelSessionsConflictError';
  }
}

export async function saveParallelSessions(sessions: ParallelSession[], version: number): Promise<{ version: number }> {
  const res = await fetch(`${API_BASE}/api/sessions/parallel`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessions, version }),
  });
  if (res.status === 409) {
    throw new ParallelSessionsConflictError();
  }
  if (!res.ok) throw new Error('Failed to save parallel sessions');
  return res.json();
}

// Shell Tabs API
export interface ShellTab {
  id: string;
  title: string;
  cwd: string;
  ptySessionId?: string;  // PTY session ID for reconnection
}

export async function fetchShellTabs(): Promise<{ tabs: ShellTab[]; activeTabId: string | null }> {
  const res = await fetch(`${API_BASE}/api/sessions/shell-tabs`);
  if (!res.ok) throw new Error('Failed to fetch shell tabs');
  return res.json();
}

export async function saveShellTabs(tabs: ShellTab[], activeTabId: string | null): Promise<void> {
  const res = await fetch(`${API_BASE}/api/sessions/shell-tabs`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tabs, activeTabId }),
  });
  if (!res.ok) throw new Error('Failed to save shell tabs');
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
  let closed = false;

  eventSource.onmessage = (event) => {
    if (closed) return;
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
    // Close the EventSource on error to prevent resource leak
    if (!closed) {
      closed = true;
      eventSource.close();
    }
    onError?.(error);
  };

  return () => {
    if (!closed) {
      closed = true;
      eventSource.close();
    }
  };
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
export type ExecutorMode = 'agent' | 'codex_only' | 'claude_only' | 'claude_direct' | 'codex_direct';

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
  // Spec agent model (for specification mode)
  spec_model?: string;
  // Executor mode: auto, codex_only, claude_only
  executor_mode?: ExecutorMode;
  // Max context tokens for agent summarization
  max_context_tokens?: number;
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

// File API types
export interface FileEntry {
  name: string;
  path: string;
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
}

export interface FileListResponse {
  path: string;
  entries: FileEntry[];
  recursive: boolean;
}

export interface FileReadResponse {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  size: number;
}

export interface FileWriteResponse {
  path: string;
  success: boolean;
  size: number;
}

// File API functions
export async function listFiles(dirPath: string, cwd: string, recursive = false): Promise<FileListResponse> {
  const res = await fetch(`${API_BASE}/api/files/list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: dirPath, cwd, recursive }),
  });
  if (!res.ok) throw new Error('Failed to list files');
  return res.json();
}

export async function readFile(filePath: string, cwd: string): Promise<FileReadResponse> {
  const res = await fetch(`${API_BASE}/api/files/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, cwd }),
  });
  if (!res.ok) throw new Error('Failed to read file');
  return res.json();
}

export async function writeFile(filePath: string, content: string, cwd: string): Promise<FileWriteResponse> {
  const res = await fetch(`${API_BASE}/api/files/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, content, cwd }),
  });
  if (!res.ok) throw new Error('Failed to write file');
  return res.json();
}

export async function createDirectory(dirPath: string, cwd: string): Promise<{ path: string; created: boolean }> {
  const res = await fetch(`${API_BASE}/api/files/mkdir`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: dirPath, cwd }),
  });
  if (!res.ok) throw new Error('Failed to create directory');
  return res.json();
}

export async function deleteFile(filePath: string, cwd: string): Promise<{ path: string; deleted: boolean }> {
  const res = await fetch(`${API_BASE}/api/files/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, cwd }),
  });
  if (!res.ok) throw new Error('Failed to delete file');
  return res.json();
}

export async function renameFile(source: string, destination: string, cwd: string): Promise<{ source: string; destination: string; moved: boolean }> {
  const res = await fetch(`${API_BASE}/api/files/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, destination, cwd }),
  });
  if (!res.ok) throw new Error('Failed to rename file');
  return res.json();
}

// Directory browsing for folder selection
export interface BrowseEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isDrive: boolean;
}

export interface BrowseResult {
  path: string;
  entries: BrowseEntry[];
  parent?: string | null;
  isRoot: boolean;
}

export async function browseDirectory(path?: string): Promise<BrowseResult> {
  const res = await fetch(`${API_BASE}/api/files/browse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: { message: 'Failed to browse directory' } }));
    throw new Error(error.error?.message || 'Failed to browse directory');
  }
  return res.json();
}

// Desktop Applications API
export interface GUIApplication {
  pid: number;
  name: string;
  title: string;
  path?: string;
}

export async function fetchApplications(): Promise<{ applications: GUIApplication[] }> {
  const res = await fetch(`${API_BASE}/api/desktop/applications`);
  if (!res.ok) throw new Error('Failed to fetch applications');
  return res.json();
}

export async function focusApplication(pid: number): Promise<{ success: boolean }> {
  const res = await fetch(`${API_BASE}/api/desktop/applications/${pid}/focus`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Failed to focus application');
  return res.json();
}

// Spec Mode API types
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  tool_calls?: Array<{
    tool: string;
    input: Record<string, unknown>;
    output?: string;
  }>;
}

export interface Conversation {
  run_id: string;
  messages: ConversationMessage[];
  created_at: string;
  updated_at: string;
}

export interface ChatResponse {
  message: string;
  tool_calls?: Array<{
    tool: string;
    input: Record<string, unknown>;
    output: string;
  }>;
  completed?: boolean;
  completion_summary?: string;
}

// Spec Mode API functions
export async function sendSpecMessage(runId: string, message: string): Promise<ChatResponse> {
  const res = await fetch(`${API_BASE}/api/runs/${runId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: { message: 'Unknown error' } }));
    throw new Error(error.error?.message || 'Failed to send message');
  }
  return res.json();
}

export async function fetchConversation(runId: string): Promise<Conversation | null> {
  const res = await fetch(`${API_BASE}/api/runs/${runId}/conversation`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Failed to fetch conversation');
  return res.json();
}

// Direct Executor API types
export type DirectExecutorType = 'claude' | 'codex';

export interface DirectExecutorSession {
  session_id: string;
  executor_type: DirectExecutorType;
  cwd: string;
  claude_session_id?: string;
  codex_thread_id?: string;
  created_at: string;
  last_activity: string;
}

export interface DirectExecutorMessage {
  executor: DirectExecutorType;
  message: ClaudeMessage | CodexMessage;
  timestamp: string;
}

// Claude message types
export interface ClaudeMessage {
  type: 'system' | 'assistant' | 'tool_use' | 'tool_result' | 'result';
  subtype?: 'init' | 'error';
  session_id?: string;
  message?: string;
  content?: string;
  tool_use_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  is_error?: boolean;
  result?: string;
}

// Codex message types
export interface CodexMessage {
  type: 'text' | 'tool_call' | 'tool_result' | 'file_change' | 'complete';
  content?: string;
  tool_call_id?: string;
  tool_name?: string;
  arguments?: Record<string, unknown>;
  output?: string;
  is_error?: boolean;
  path?: string;
  action?: 'create' | 'modify' | 'delete';
  result?: string;
  thread_id?: string;
}

// Direct Executor API functions
export async function createDirectExecutorSession(
  executorType: DirectExecutorType,
  cwd: string
): Promise<DirectExecutorSession> {
  const res = await fetch(`${API_BASE}/api/direct-executor/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ executor_type: executorType, cwd }),
  });
  if (!res.ok) throw new Error('Failed to create executor session');
  return res.json();
}

export async function fetchDirectExecutorSessions(): Promise<{ sessions: DirectExecutorSession[] }> {
  const res = await fetch(`${API_BASE}/api/direct-executor/sessions`);
  if (!res.ok) throw new Error('Failed to fetch executor sessions');
  return res.json();
}

export async function fetchDirectExecutorSession(sessionId: string): Promise<{ session: DirectExecutorSession }> {
  const res = await fetch(`${API_BASE}/api/direct-executor/sessions/${sessionId}`);
  if (!res.ok) throw new Error('Failed to fetch executor session');
  return res.json();
}

export async function deleteDirectExecutorSession(sessionId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/direct-executor/sessions/${sessionId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete executor session');
}

/**
 * Subscribe to direct executor query results via SSE
 */
export function subscribeToDirectExecutorQuery(
  sessionId: string,
  prompt: string,
  onMessage: (msg: DirectExecutorMessage) => void,
  onError?: (error: Error) => void,
  onComplete?: () => void
): () => void {
  const controller = new AbortController();

  fetch(`${API_BASE}/api/direct-executor/sessions/${sessionId}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
        throw new Error(error.error?.message || 'Query failed');
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        onError?.(new Error('No response body'));
        return;
      }

      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === 'done' || parsed.type === 'error') {
                if (parsed.type === 'error') {
                  onError?.(new Error(parsed.message));
                }
                onComplete?.();
                return;
              }
              // It's a message event
              if (parsed.executor && parsed.message) {
                onMessage(parsed as DirectExecutorMessage);
              }
            } catch {
              // Ignore parse errors for incomplete data
            }
          }
        }
      }
      onComplete?.();
    })
    .catch((error) => {
      if (error.name !== 'AbortError') {
        onError?.(error);
      }
    });

  return () => controller.abort();
}

// =============================================================================
// MCP OAuth API
// =============================================================================

export interface MCPOAuthClient {
  client_id: string;
  client_name: string;
  client_secret?: string;
  redirect_uris: string[];
  scope: string;
  is_public: boolean;
  created_at: string;
}

export interface MCPServerConfig {
  mcp_server_url: string;
  oauth_endpoints: {
    authorization: string;
    authorize: string;
    token: string;
  };
  available_scopes: string[];
}

export async function fetchMCPClients(): Promise<{ clients: MCPOAuthClient[] }> {
  const res = await fetch(`${API_BASE}/api/mcp/clients`);
  if (!res.ok) throw new Error('Failed to fetch MCP clients');
  return res.json();
}

export async function fetchMCPConfig(): Promise<MCPServerConfig> {
  const res = await fetch(`${API_BASE}/api/mcp/config`);
  if (!res.ok) throw new Error('Failed to fetch MCP config');
  return res.json();
}

export async function createMCPClient(data: {
  client_name: string;
  redirect_uris: string[];
  scope: string;
  is_public: boolean;
}): Promise<MCPOAuthClient> {
  const res = await fetch(`${API_BASE}/api/mcp/clients`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to create MCP client');
  return res.json();
}

export async function deleteMCPClient(clientId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/mcp/clients/${clientId}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to delete MCP client');
}

export async function regenerateMCPClientSecret(clientId: string): Promise<MCPOAuthClient> {
  const res = await fetch(`${API_BASE}/api/mcp/clients/${clientId}/regenerate-secret`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Failed to regenerate MCP client secret');
  return res.json();
}
