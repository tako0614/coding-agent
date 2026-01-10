import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Loader2,
  FolderOpen,
  Send,
  Clock,
  CheckCircle,
  XCircle,
  Trash2,
  Square,
  Terminal,
  List,
  MessageSquare,
  ChevronDown,
} from 'lucide-react';
import {
  fetchProject,
  fetchRuns,
  fetchRun,
  createRun,
  deleteRun,
  subscribeToLogs,
  fetchDAG,
  fetchLogs,
  fetchCopilotModels,
  fetchCopilotStatus,
  fetchSettings,
  updateSettings,
  type LogEntry,
  type DAG,
  type CopilotModel,
} from '../lib/api';
import clsx from 'clsx';
import { ChatMessage, type ChatMessageData } from '../components/chat';

// --- Types ---
type AgentStatus = 'idle' | 'running' | 'completed' | 'failed';

// --- Raw Log Entry Component ---
function RawLogEntry({ log }: { log: LogEntry }) {
  const levelColors: Record<string, string> = {
    debug: 'text-slate-400',
    info: 'text-blue-600',
    warn: 'text-amber-600',
    error: 'text-red-600',
  };

  const levelBg: Record<string, string> = {
    debug: 'bg-slate-100',
    info: 'bg-blue-50',
    warn: 'bg-amber-50',
    error: 'bg-red-50',
  };

  return (
    <div className={clsx('px-3 py-2 border-b border-slate-100 font-mono text-xs', levelBg[log.level] || 'bg-white')}>
      <div className="flex items-start gap-2">
        <span className="text-slate-400 shrink-0">
          {new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
        <span className={clsx('font-semibold uppercase shrink-0 w-12', levelColors[log.level] || 'text-slate-500')}>
          {log.level}
        </span>
        <span className="text-purple-600 shrink-0">[{log.source}]</span>
        <span className="text-slate-700 break-all flex-1">{log.message}</span>
      </div>
      {log.metadata && Object.keys(log.metadata).length > 0 && (
        <div className="mt-1 ml-[120px] text-slate-500">
          <pre className="text-[10px] bg-white/50 rounded p-1 overflow-x-auto">
            {JSON.stringify(log.metadata, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

// --- Progress Indicator ---
function ProgressIndicator({ current, total }: { current: number; total: number }) {
  const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2 text-xs text-slate-500">
      <div className="w-24 h-1 bg-slate-200 rounded-full overflow-hidden">
        <div
          className="h-full bg-blue-500 transition-all duration-300"
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span>{current}/{total}</span>
    </div>
  );
}

// --- Storage Keys ---
const STORAGE_KEY_RUN_ID = (projectId: string) => `supervisor_run_${projectId}`;
const STORAGE_KEY_USER_GOAL = (projectId: string) => `supervisor_goal_${projectId}`;

// --- Chat Panel ---
function ChatPanel({ projectId, repoPath }: { projectId: string; repoPath: string }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AgentStatus>('idle');
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [dag, setDag] = useState<DAG | null>(null);
  const [rawLogs, setRawLogs] = useState<LogEntry[]>([]);
  const [viewMode, setViewMode] = useState<'chat' | 'logs'>('chat');
  const [isRestoring, setIsRestoring] = useState(true);
  const [selectedModel, setSelectedModel] = useState('gpt-5.2');
  const [showModelDropdown, setShowModelDropdown] = useState(false);

  // Chat messages (new format)
  const [chatMessages, setChatMessages] = useState<ChatMessageData[]>([]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Copilot status and models
  const { data: copilotStatus } = useQuery({
    queryKey: ['copilotStatus'],
    queryFn: fetchCopilotStatus,
    refetchInterval: 10000,
  });

  const { data: copilotModels } = useQuery({
    queryKey: ['copilotModels'],
    queryFn: fetchCopilotModels,
    enabled: copilotStatus?.running && copilotStatus?.healthy,
    staleTime: 60000,
  });

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
  });

  const updateSettingsMutation = useMutation({
    mutationFn: updateSettings,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  // Sync model from settings
  useEffect(() => {
    if (settings?.dag_model) {
      setSelectedModel(settings.dag_model);
    }
  }, [settings?.dag_model]);

  const handleModelChange = (model: string) => {
    setSelectedModel(model);
    setShowModelDropdown(false);
    updateSettingsMutation.mutate({ dag_model: model });
  };

  const availableModels = (copilotModels?.models ?? []).map((m: CopilotModel) => m.id);

  // Restore active run on mount
  useEffect(() => {
    const restoreRun = async () => {
      const savedRunId = localStorage.getItem(STORAGE_KEY_RUN_ID(projectId));
      const savedGoal = localStorage.getItem(STORAGE_KEY_USER_GOAL(projectId));

      if (!savedRunId) {
        setIsRestoring(false);
        return;
      }

      try {
        // Check if run is still active
        const run = await fetchRun(savedRunId);

        if (run.status === 'running' || run.status === 'pending') {
          // Run is still active, restore it
          setCurrentRunId(savedRunId);
          setStatus('running');

          // Add user message from saved goal
          if (savedGoal) {
            setChatMessages([{
              id: `user-restored-${Date.now()}`,
              type: 'user',
              content: savedGoal,
              timestamp: run.created_at,
            }]);
          }

          // Fetch historical logs
          const { logs } = await fetchLogs(savedRunId);
          console.log(`[Restore] Loaded ${logs.length} historical logs`);

          // Process historical logs into chat messages and raw logs
          const restoredMessages: ChatMessageData[] = savedGoal ? [{
            id: `user-restored-${Date.now()}`,
            type: 'user',
            content: savedGoal,
            timestamp: run.created_at,
          }] : [];

          logs.forEach((entry) => {
            // Add to raw logs
            setRawLogs(prev => [...prev, entry]);

            // Convert to chat message (same logic as SSE handler)
            const meta = entry.metadata as Record<string, unknown> | undefined;
            const executor = (entry.source === 'claude' || entry.source === 'codex')
              ? entry.source as 'claude' | 'codex'
              : undefined;

            if (entry.source === 'supervisor') {
              if (entry.message.includes('▶') || entry.message.includes('✓') || entry.message.includes('✗')) {
                restoredMessages.push({
                  id: `sys-${entry.timestamp}-${Math.random().toString(36).slice(2, 6)}`,
                  type: 'system',
                  content: entry.message,
                  timestamp: entry.timestamp,
                });
              }
            } else if (entry.source === 'claude' || entry.source === 'codex') {
              const msgType = meta?.type as string;
              if (msgType === 'assistant') {
                const fullContent = (meta?.full_content as string) || entry.message;
                if (fullContent && fullContent.length > 5) {
                  restoredMessages.push({
                    id: `asst-${entry.timestamp}-${Math.random().toString(36).slice(2, 6)}`,
                    type: 'assistant',
                    content: fullContent,
                    timestamp: entry.timestamp,
                    executor,
                  });
                }
              } else if (msgType === 'tool_use') {
                restoredMessages.push({
                  id: `tool-${meta?.tool_use_id || entry.timestamp}`,
                  type: 'tool_use',
                  content: entry.message,
                  timestamp: entry.timestamp,
                  toolName: meta?.tool_name as string,
                  toolInput: meta?.tool_input as Record<string, unknown>,
                  executor,
                });
              } else if (msgType === 'tool_result') {
                restoredMessages.push({
                  id: `result-${meta?.tool_use_id || entry.timestamp}`,
                  type: 'tool_result',
                  content: (meta?.full_content as string) || entry.message,
                  timestamp: entry.timestamp,
                  isError: meta?.is_error as boolean,
                  executor,
                });
              } else if (msgType === 'result') {
                restoredMessages.push({
                  id: `final-${entry.timestamp}-${Math.random().toString(36).slice(2, 6)}`,
                  type: 'result',
                  content: (meta?.full_result as string) || entry.message,
                  timestamp: entry.timestamp,
                  executor,
                });
              }
            }
          });

          setChatMessages(restoredMessages);

          // Fetch DAG if available
          const dagData = await fetchDAG(savedRunId).catch(() => null);
          if (dagData) setDag(dagData);

        } else if (run.status === 'completed' || run.status === 'failed') {
          // Run is finished, clear storage
          localStorage.removeItem(STORAGE_KEY_RUN_ID(projectId));
          localStorage.removeItem(STORAGE_KEY_USER_GOAL(projectId));
        }
      } catch (e) {
        console.error('Failed to restore run:', e);
        // Clear invalid run from storage
        localStorage.removeItem(STORAGE_KEY_RUN_ID(projectId));
        localStorage.removeItem(STORAGE_KEY_USER_GOAL(projectId));
      }

      setIsRestoring(false);
    };

    restoreRun();
  }, [projectId]);

  // Auto-scroll
  useEffect(() => {
    if (viewMode === 'chat') {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    } else {
      logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, rawLogs, viewMode]);

  // Helper to add a chat message
  const addChatMessage = useCallback((message: ChatMessageData) => {
    setChatMessages(prev => {
      // Avoid duplicates by ID
      if (prev.some(m => m.id === message.id)) {
        return prev;
      }
      return [...prev, message];
    });
  }, []);

  // Handle run completion (called from SSE handler)
  const handleRunComplete = useCallback((success: boolean, message: string) => {
    setStatus(success ? 'completed' : 'failed');
    localStorage.removeItem(STORAGE_KEY_RUN_ID(projectId));
    localStorage.removeItem(STORAGE_KEY_USER_GOAL(projectId));
    addChatMessage({
      id: `complete-${Date.now()}`,
      type: 'system',
      content: message,
      timestamp: new Date().toISOString(),
    });
  }, [projectId, addChatMessage]);

  // Subscribe to logs and convert to chat messages
  useEffect(() => {
    if (!currentRunId) return;

    const unsubscribe = subscribeToLogs(
      currentRunId,
      (entry: LogEntry) => {
        // Always add to raw logs (keep last 500)
        setRawLogs(prev => [...prev.slice(-499), entry]);

        const meta = entry.metadata as Record<string, unknown> | undefined;
        const executor = (entry.source === 'claude' || entry.source === 'codex')
          ? entry.source as 'claude' | 'codex'
          : undefined;

        // Debug: log all messages
        console.log('[SSE]', entry.source, meta?.type, entry.message.slice(0, 80));

        // ===== Supervisor events (system messages) =====
        if (entry.source === 'supervisor') {
          // Run completed (from finalize node)
          if (entry.message.includes('✅ Run completed')) {
            handleRunComplete(true, entry.message);
            return;
          }
          // Run failed (from finalize node)
          if (entry.message.includes('❌ Run failed') || entry.message.includes('Run failed')) {
            handleRunComplete(false, entry.message);
            return;
          }

          // Task started
          if (entry.message.includes('Task started:') || entry.message.includes('▶')) {
            const taskName = entry.message.replace(/▶\s*Task started:\s*/i, '').trim();
            addChatMessage({
              id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              type: 'system',
              content: `Starting: ${taskName}`,
              timestamp: entry.timestamp,
            });
          }
          // Task completed
          else if (entry.message.includes('Task completed:') || entry.message.includes('✓')) {
            const taskName = entry.message.replace(/✓\s*Task completed:\s*/i, '').trim();
            addChatMessage({
              id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              type: 'system',
              content: `Completed: ${taskName}`,
              timestamp: entry.timestamp,
            });
          }
          // Task failed
          else if (entry.message.includes('Task failed:') || entry.message.includes('✗')) {
            addChatMessage({
              id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              type: 'system',
              content: entry.message,
              timestamp: entry.timestamp,
            });
          }
        }

        // ===== Worker events (claude, codex) =====
        if (entry.source === 'claude' || entry.source === 'codex') {
          const msgType = meta?.type as string;

          // Assistant thinking/message
          if (msgType === 'assistant') {
            const fullContent = (meta?.full_content as string) || entry.message;
            // Skip empty or very short messages
            if (fullContent && fullContent.length > 5) {
              addChatMessage({
                id: `asst-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                type: 'assistant',
                content: fullContent,
                timestamp: entry.timestamp,
                executor,
              });
            }
          }
          // Tool use
          else if (msgType === 'tool_use') {
            const toolName = meta?.tool_name as string;
            const toolInput = meta?.tool_input as Record<string, unknown>;
            const toolUseId = meta?.tool_use_id as string;

            addChatMessage({
              id: `tool-${toolUseId || Date.now()}`,
              type: 'tool_use',
              content: entry.message,
              timestamp: entry.timestamp,
              toolName,
              toolInput,
              executor,
            });
          }
          // Tool result
          else if (msgType === 'tool_result') {
            const toolUseId = meta?.tool_use_id as string;
            const isError = meta?.is_error as boolean;
            const content = (meta?.full_content as string) || entry.message;

            addChatMessage({
              id: `result-${toolUseId || Date.now()}`,
              type: 'tool_result',
              content,
              timestamp: entry.timestamp,
              isError,
              executor,
            });
          }
          // Final result
          else if (msgType === 'result') {
            const fullResult = (meta?.full_result as string) || entry.message;
            addChatMessage({
              id: `final-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              type: 'result',
              content: fullResult,
              timestamp: entry.timestamp,
              executor,
            });
          }
        }
      },
      (err) => console.error('SSE error:', err)
    );

    return unsubscribe;
  }, [currentRunId, addChatMessage, handleRunComplete]);

  const handleSend = async () => {
    const content = input.trim();
    if (!content) return;

    setInput('');

    // Add user message
    addChatMessage({
      id: `user-${Date.now()}`,
      type: 'user',
      content,
      timestamp: new Date().toISOString(),
    });

    if (status !== 'running') {
      setStatus('running');
      setRawLogs([]);
      setChatMessages(prev => prev.filter(m => m.type === 'user')); // Keep only the user message
      setDag(null);

      try {
        const result = await createRun({
          goal: content,
          repoPath,
          projectId,
        });
        setCurrentRunId(result.run_id);

        // Save to localStorage for recovery
        localStorage.setItem(STORAGE_KEY_RUN_ID(projectId), result.run_id);
        localStorage.setItem(STORAGE_KEY_USER_GOAL(projectId), content);

        // Add system message
        addChatMessage({
          id: `start-${Date.now()}`,
          type: 'system',
          content: 'Starting execution...',
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        setStatus('failed');
        addChatMessage({
          id: `error-${Date.now()}`,
          type: 'system',
          content: `Error: ${e instanceof Error ? e.message : 'Failed to start'}`,
          timestamp: new Date().toISOString(),
        });
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleStop = () => {
    setStatus('idle');
    setCurrentRunId(null);
    // Clear storage when stopped
    localStorage.removeItem(STORAGE_KEY_RUN_ID(projectId));
    localStorage.removeItem(STORAGE_KEY_USER_GOAL(projectId));
    addChatMessage({
      id: `stop-${Date.now()}`,
      type: 'system',
      content: 'Stopped by user',
      timestamp: new Date().toISOString(),
    });
  };

  // Show loading state while restoring
  if (isRestoring) {
    return (
      <div className="flex flex-col h-[calc(100vh-64px)] items-center justify-center bg-white">
        <Loader2 className="animate-spin text-blue-500 mb-4" size={32} />
        <p className="text-sm text-slate-500">Restoring session...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      {/* Progress Bar + View Toggle */}
      <div className="px-4 py-2 border-b border-slate-100 bg-white flex items-center justify-between">
        <div className="flex-1">
          {status === 'running' && dag?.progress && (
            <ProgressIndicator current={dag.progress.completed} total={dag.progress.total} />
          )}
        </div>

        {/* View Mode Toggle */}
        <div className="flex bg-slate-100 rounded-lg p-0.5">
          <button
            onClick={() => setViewMode('chat')}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors',
              viewMode === 'chat'
                ? 'bg-white text-slate-800 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            )}
          >
            <MessageSquare size={12} />
            Chat
            {chatMessages.length > 0 && (
              <span className="ml-1 px-1.5 py-0.5 bg-blue-100 text-blue-600 rounded-full text-[10px]">
                {chatMessages.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setViewMode('logs')}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors',
              viewMode === 'logs'
                ? 'bg-white text-slate-800 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            )}
          >
            <List size={12} />
            Raw Logs
            {rawLogs.length > 0 && (
              <span className="ml-1 px-1.5 py-0.5 bg-slate-200 text-slate-600 rounded-full text-[10px]">
                {rawLogs.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Chat View (Main View) */}
      {viewMode === 'chat' && (
        <div className="flex-1 overflow-y-auto bg-white">
          {/* Empty state */}
          {chatMessages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-slate-400">
              <MessageSquare size={40} className="mb-4 opacity-30" />
              <p className="text-sm">Enter a goal to start</p>
            </div>
          )}

          {/* Chat Messages */}
          <div className="divide-y divide-slate-100">
            {chatMessages.map((msg) => (
              <ChatMessage key={msg.id} message={msg} />
            ))}
          </div>

          {/* Running indicator */}
          {status === 'running' && (
            <div className="flex items-center gap-2 px-4 py-3 text-slate-500 bg-slate-50">
              <Loader2 size={14} className="animate-spin" />
              <span className="text-sm">Processing...</span>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      )}

      {/* Raw Logs View */}
      {viewMode === 'logs' && (
        <div className="flex-1 overflow-y-auto bg-slate-900">
          {rawLogs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-400">
              <Terminal size={40} className="mb-4 opacity-30" />
              <p className="text-sm">No logs yet. Start a task to see all messages.</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-800">
              {rawLogs.map((log, idx) => (
                <RawLogEntry key={`${log.timestamp}-${idx}`} log={log} />
              ))}
              <div ref={logsEndRef} />
            </div>
          )}
        </div>
      )}

      {/* Input Area */}
      <div className="border-t border-slate-200 bg-white p-4">
        <div className="max-w-3xl mx-auto">
          {/* Model Selector */}
          <div className="relative mb-2">
            <button
              onClick={() => setShowModelDropdown(!showModelDropdown)}
              disabled={status === 'running'}
              className="flex items-center gap-1.5 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 rounded-md transition-colors disabled:opacity-50"
            >
              <span className="font-medium">{selectedModel}</span>
              <ChevronDown size={12} />
            </button>
            {showModelDropdown && availableModels.length > 0 && (
              <div className="absolute bottom-full left-0 mb-1 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[180px] max-h-[300px] overflow-y-auto z-50">
                {availableModels.map((model) => (
                  <button
                    key={model}
                    onClick={() => handleModelChange(model)}
                    className={clsx(
                      'w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50 transition-colors',
                      model === selectedModel ? 'bg-blue-50 text-blue-600' : 'text-slate-700'
                    )}
                  >
                    {model}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Input */}
          <div className="relative">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask me to build, fix, or explain something..."
              className="w-full resize-none border border-slate-200 rounded-xl px-4 py-3 pr-24 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent min-h-[52px] max-h-[200px]"
              rows={1}
              disabled={status === 'running'}
            />
            <div className="absolute right-2 bottom-2 flex items-center gap-2">
              {status === 'running' ? (
                <button
                  onClick={handleStop}
                  className="p-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
                  title="Stop"
                >
                  <Square size={16} />
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!input.trim()}
                  className={clsx(
                    'p-2 rounded-lg transition-colors',
                    input.trim()
                      ? 'bg-blue-500 text-white hover:bg-blue-600'
                      : 'bg-slate-100 text-slate-400 cursor-not-allowed'
                  )}
                >
                  <Send size={16} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Run History ---
function RunHistory() {
  const queryClient = useQueryClient();

  const { data: runs, isLoading } = useQuery({
    queryKey: ['runs'],
    queryFn: fetchRuns,
    // No auto-refresh - history is fetched when tab is shown
    staleTime: 30000, // Consider fresh for 30 seconds
  });

  const deleteMutation = useMutation({
    mutationFn: deleteRun,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['runs'] });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="animate-spin text-slate-400" />
      </div>
    );
  }

  const projectRuns = runs?.runs || [];

  if (projectRuns.length === 0) {
    return (
      <div className="text-center py-16 text-slate-400">
        <Clock size={40} className="mx-auto mb-4 opacity-30" />
        <p className="text-sm">No history yet</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-3 max-w-3xl mx-auto">
      {projectRuns.map((run) => (
        <div key={run.run_id} className="bg-white rounded-xl border border-slate-200 p-4 group hover:border-slate-300 transition-colors">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-2">
                {run.status === 'completed' && <CheckCircle size={16} className="text-green-500" />}
                {run.status === 'failed' && <XCircle size={16} className="text-red-500" />}
                {run.status === 'running' && <Loader2 size={16} className="text-blue-500 animate-spin" />}
                {run.status === 'pending' && <Clock size={16} className="text-yellow-500" />}
                <span className="text-xs text-slate-400">
                  {new Date(run.created_at).toLocaleString()}
                </span>
              </div>
              <p className="text-sm text-slate-700 line-clamp-2">{run.user_goal}</p>
            </div>
            <button
              onClick={() => deleteMutation.mutate(run.run_id)}
              className="p-2 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// --- Main Page ---
export default function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [activeTab, setActiveTab] = useState<'chat' | 'history'>('chat');

  const { data: project, isLoading, error } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => fetchProject(projectId!),
    enabled: !!projectId,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50">
        <Loader2 className="animate-spin text-blue-500" size={32} />
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-slate-50">
        <XCircle className="text-red-400 mb-4" size={48} />
        <h2 className="text-lg font-medium text-slate-800 mb-2">Project not found</h2>
        <Link to="/" className="text-blue-500 hover:underline text-sm">Go back</Link>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 shrink-0">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center gap-4">
          <Link to="/" className="p-2 hover:bg-slate-100 rounded-lg transition-colors -ml-2">
            <ArrowLeft size={20} className="text-slate-500" />
          </Link>

          <div className="flex-1 min-w-0">
            <h1 className="font-semibold text-slate-800 truncate">{project.name}</h1>
            <div className="flex items-center gap-1.5 text-xs text-slate-400">
              <FolderOpen size={12} />
              <span className="font-mono truncate">{project.repo_path}</span>
            </div>
          </div>

          <div className="flex bg-slate-100 rounded-lg p-1">
            <button
              onClick={() => setActiveTab('chat')}
              className={clsx(
                'px-4 py-1.5 rounded-md text-sm font-medium transition-colors',
                activeTab === 'chat'
                  ? 'bg-white text-slate-800 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              )}
            >
              Chat
            </button>
            <button
              onClick={() => setActiveTab('history')}
              className={clsx(
                'px-4 py-1.5 rounded-md text-sm font-medium transition-colors',
                activeTab === 'history'
                  ? 'bg-white text-slate-800 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              )}
            >
              History
            </button>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-hidden">
        {activeTab === 'chat' ? (
          <ChatPanel projectId={projectId!} repoPath={project.repo_path} />
        ) : (
          <RunHistory />
        )}
      </main>
    </div>
  );
}
