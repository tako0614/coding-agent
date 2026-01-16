import { useEffect, useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Send,
  Square,
  Loader2,
  ChevronDown,
  FolderOpen,
  MessageSquare,
  Terminal,
  Trash2,
  Columns,
  List,
  Plus,
  X,
} from 'lucide-react';

import {
  fetchProjects,
  fetchRun,
  fetchRuns,
  createRun,
  subscribeToLogs,
  fetchLogs,
  fetchOrphanedSessions,
  deleteOrphanedSession,
  fetchCopilotModels,
  fetchCopilotStatus,
  fetchSettings,
  updateSettings,
  fetchParallelSessions,
  saveParallelSessions,
  ParallelSessionsConflictError,
  sendSpecMessage,
  fetchConversation,
  type Project,
  type LogEntry,
  type CopilotModel,
  type ExecutorMode,
  type ParallelSession,
  type RunMode,
} from '../lib/api';
import clsx from 'clsx';
import { ChatMessage, type ChatMessageData, type MessageType } from '../components/chat';

// Helper function to parse log entries and determine message type
function parseLogToMessage(entry: LogEntry): ChatMessageData | null {
  const meta = entry.metadata as Record<string, unknown> | undefined;
  const executor = (entry.source === 'claude' || entry.source === 'codex')
    ? entry.source as 'claude' | 'codex'
    : undefined;

  // Skip debug messages
  if (entry.level === 'debug') return null;

  const msg = entry.message;

  // Completion/Failure result patterns - show prominently
  if (msg.includes('✅ Completed') || msg.includes('✅ Run completed')) {
    // Use full summary from metadata if available, otherwise extract from message
    const fullSummary = meta?.final_summary as string | undefined;
    const content = fullSummary || msg.replace(/^✅\s*(Completed:|Run completed:?)\s*/i, '').trim() || '完了しました';
    return {
      id: `${entry.timestamp}-${Math.random()}`,
      type: 'result' as MessageType,
      content,
      timestamp: entry.timestamp,
      executor: undefined, // Supervisor completion - use neutral styling
      metadata: meta,
    };
  }

  if (msg.includes('❌ Failed') || msg.includes('❌ Run failed')) {
    return {
      id: `${entry.timestamp}-${Math.random()}`,
      type: 'tool_result' as MessageType,
      content: msg.replace(/^❌\s*(Failed:|Run failed:?)\s*/i, '').trim() || 'エラーが発生しました',
      timestamp: entry.timestamp,
      isError: true,
      executor,
      metadata: meta,
    };
  }

  // Tool execution patterns
  if (msg.includes('Executing tool') || msg.includes('Tool:')) {
    const toolMatch = msg.match(/tool[:\s]+(\w+)/i);
    return {
      id: `${entry.timestamp}-${Math.random()}`,
      type: 'tool_use' as MessageType,
      content: msg,
      timestamp: entry.timestamp,
      toolName: toolMatch?.[1] || 'Tool',
      toolInput: meta?.args as Record<string, unknown> | undefined,
      executor,
      metadata: meta,
    };
  }

  // Worker task patterns
  if (msg.includes('Spawning workers') || msg.includes('Worker') || msg.includes('タスク')) {
    return {
      id: `${entry.timestamp}-${Math.random()}`,
      type: 'system' as MessageType,
      content: msg,
      timestamp: entry.timestamp,
      executor,
      metadata: meta,
    };
  }

  // Error patterns
  if (entry.level === 'error') {
    return {
      id: `${entry.timestamp}-${Math.random()}`,
      type: 'tool_result' as MessageType,
      content: msg,
      timestamp: entry.timestamp,
      isError: true,
      executor,
      metadata: meta,
    };
  }

  // Result patterns
  if (msg.includes('Result:') || msg.includes('完了') || msg.includes('成功')) {
    return {
      id: `${entry.timestamp}-${Math.random()}`,
      type: 'tool_result' as MessageType,
      content: msg,
      timestamp: entry.timestamp,
      isError: false,
      executor,
      metadata: meta,
    };
  }

  // Supervisor/Agent messages - display as assistant (NOT Claude!)
  if (entry.source === 'supervisor' || entry.source === 'system') {
    return {
      id: `${entry.timestamp}-${Math.random()}`,
      type: 'assistant' as MessageType,
      content: msg,
      timestamp: entry.timestamp,
      executor: undefined, // Supervisor - use neutral styling, NOT Claude
      metadata: meta,
    };
  }

  // Claude/Codex executor messages
  if (executor) {
    return {
      id: `${entry.timestamp}-${Math.random()}`,
      type: 'assistant' as MessageType,
      content: msg,
      timestamp: entry.timestamp,
      executor,
      metadata: meta,
    };
  }

  // Default: show as assistant message (errors handled above, so this is info/warn)
  return {
    id: `${entry.timestamp}-${Math.random()}`,
    type: 'assistant' as MessageType,
    content: msg,
    timestamp: entry.timestamp,
    status: entry.level === 'warn' ? 'error' : 'success',
    metadata: meta,
  };
}

// --- Types ---
type AgentStatus = 'idle' | 'running' | 'completed' | 'failed' | 'interrupted';

interface AgentSession {
  id: string;
  projectId: string | null;
  runId: string | null;
  mode: RunMode;
  status: AgentStatus;
  input: string;
  messages: ChatMessageData[];
  logs: LogEntry[];
  selectedModel?: string;
  executorMode?: ExecutorMode;
  terminalSessionId?: string;  // PTY session ID for reconnection
}

// --- Shared Agent Panel Component ---
function AgentPanel({
  session,
  projects,
  onUpdate,
  onClose,
  onBack,
  showViewToggle = true,
  availableModels,
  selectedModel,
  onModelChange,
  executorMode,
  onExecutorModeChange,
}: {
  session: AgentSession;
  projects: Project[];
  onUpdate: (updates: Partial<AgentSession>) => void;
  onClose?: () => void;
  onBack?: () => void;
  showViewToggle?: boolean;
  availableModels?: string[];
  selectedModel?: string;
  onModelChange?: (model: string) => void;
  executorMode?: ExecutorMode;
  onExecutorModeChange?: (mode: ExecutorMode) => void;
}) {
  const queryClient = useQueryClient();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [showProjectDropdown, setShowProjectDropdown] = useState(false);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showExecutorDropdown, setShowExecutorDropdown] = useState(false);
  const [viewMode, setViewMode] = useState<'chat' | 'logs'>('chat');

  const selectedProject = projects.find(p => p.project_id === session.projectId);

  // Auto-scroll when running
  useEffect(() => {
    if (session.status === 'running') {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [session.messages.length, session.logs.length, session.status]);

  // Subscribe to logs when running
  useEffect(() => {
    if (!session.runId || session.status !== 'running') return;

    const unsubscribe = subscribeToLogs(session.runId, (entry) => {
      onUpdate({
        logs: [...session.logs, entry],
      });

      // Parse log entry to appropriate message type
      const newMessage = parseLogToMessage(entry);
      if (newMessage) {
        onUpdate({
          messages: [...session.messages, newMessage],
        });
      }

      // Check for completion
      if (entry.message.includes('✅ Completed') || entry.message.includes('Run completed')) {
        onUpdate({ status: 'completed' });
      } else if (entry.message.includes('❌ Failed') || entry.message.includes('Run failed')) {
        onUpdate({ status: 'failed' });
      }
    });

    return unsubscribe;
  }, [session.runId, session.status, session.id]);

  // Restore run on mount
  useEffect(() => {
    if (!session.runId || session.messages.length > 0) return;

    const restore = async () => {
      try {
        const run = await fetchRun(session.runId!);
        // Always load logs from database
        const { logs } = await fetchLogs(session.runId!);
        const restoredMessages: ChatMessageData[] = logs
          .map(l => parseLogToMessage(l))
          .filter((m): m is ChatMessageData => m !== null);

        if (run.status === 'running' || run.status === 'pending') {
          onUpdate({ status: 'running', messages: restoredMessages, logs });
        } else if (run.status === 'completed') {
          onUpdate({ status: 'completed', messages: restoredMessages, logs });
        } else if (run.status === 'failed' || run.status === 'interrupted') {
          onUpdate({ status: 'failed', messages: restoredMessages, logs });
        }
      } catch {
        onUpdate({ runId: null, status: 'idle' });
      }
    };
    restore();
  }, [session.runId]);

  const createRunMutation = useMutation({
    mutationFn: (options: { goal: string; repoPath: string; projectId?: string }) => createRun(options),
    onSuccess: (data) => {
      onUpdate({
        runId: data.run_id,
        status: 'running',
        messages: [
          ...session.messages,
          {
            id: `user-${Date.now()}`,
            type: 'user',
            content: session.input,
            timestamp: new Date().toISOString(),
          },
        ],
        input: '',
      });
      queryClient.invalidateQueries({ queryKey: ['runs'] });
    },
  });

  const handleSend = () => {
    if (!session.input.trim() || !session.projectId || !selectedProject) return;
    createRunMutation.mutate({
      goal: session.input,
      repoPath: selectedProject.repo_path,
      projectId: session.projectId,
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleStop = () => {
    onUpdate({ status: 'idle' });
  };

  return (
    <div className={clsx(
      "flex flex-col h-full bg-white",
      onClose && "border-r border-slate-200 w-[320px] min-w-[280px] max-w-[400px] flex-shrink-0"
    )}>
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-slate-200 bg-slate-50">
        <div className="flex items-center gap-3">
          {onBack && (
            <button
              onClick={onBack}
              className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
            >
              <ArrowLeft size={20} />
            </button>
          )}

          {/* Project Selector */}
          <div className="relative">
            <button
              onClick={() => setShowProjectDropdown(!showProjectDropdown)}
              disabled={session.status === 'running'}
              className="flex items-center gap-2 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 rounded-lg transition-colors disabled:opacity-50"
            >
              <FolderOpen size={16} />
              <span className="truncate max-w-[200px]">
                {selectedProject?.name || 'Select Project'}
              </span>
              <ChevronDown size={14} />
            </button>
            {showProjectDropdown && (
              <div className="absolute top-full left-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[250px] max-h-[300px] overflow-y-auto z-50">
                {projects.map((project) => (
                  <button
                    key={project.project_id}
                    onClick={() => {
                      onUpdate({ projectId: project.project_id });
                      setShowProjectDropdown(false);
                    }}
                    className={clsx(
                      'w-full text-left px-3 py-2 text-sm hover:bg-slate-50',
                      project.project_id === session.projectId && 'bg-primary-50 text-primary-600'
                    )}
                  >
                    <div className="font-medium truncate">{project.name}</div>
                    <div className="text-xs text-slate-400 truncate">{project.repo_path}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Status & Close */}
        <div className="flex items-center gap-2">
          {session.status === 'running' && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-yellow-100 text-yellow-700 rounded-full">
              <Loader2 size={10} className="animate-spin" />
              実行中
            </span>
          )}
          {session.status === 'completed' && (
            <span className="px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700 rounded-full">
              完了
            </span>
          )}
          {session.status === 'failed' && (
            <span className="px-2 py-0.5 text-xs font-medium bg-red-100 text-red-700 rounded-full">
              失敗
            </span>
          )}
          {onClose && (
            <button
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
            >
              <X size={18} />
            </button>
          )}
        </div>
      </div>

      {/* View Toggle */}
      {showViewToggle && (
        <div className="flex border-b border-slate-200">
          <button
            onClick={() => setViewMode('chat')}
            className={clsx(
              'flex-1 px-4 py-2 text-sm font-medium transition-colors',
              viewMode === 'chat'
                ? 'text-primary-600 border-b-2 border-primary-600'
                : 'text-slate-500 hover:text-slate-700'
            )}
          >
            <MessageSquare size={14} className="inline mr-2" />
            Chat
          </button>
          <button
            onClick={() => setViewMode('logs')}
            className={clsx(
              'flex-1 px-4 py-2 text-sm font-medium transition-colors',
              viewMode === 'logs'
                ? 'text-primary-600 border-b-2 border-primary-600'
                : 'text-slate-500 hover:text-slate-700'
            )}
          >
            <Terminal size={14} className="inline mr-2" />
            Logs
          </button>
        </div>
      )}

      {/* Messages/Logs Area */}
      <div className="flex-1 overflow-y-auto">
        {viewMode === 'chat' ? (
          <div className="max-w-3xl mx-auto p-4 space-y-3">
            {session.messages.length === 0 ? (
              <div className="text-center text-slate-400 text-sm py-16">
                {session.projectId ? 'メッセージを送信して開始' : 'まずプロジェクトを選択してください'}
              </div>
            ) : (
              session.messages.map((msg) => (
                <ChatMessage key={msg.id} message={msg} />
              ))
            )}
            <div ref={messagesEndRef} />
          </div>
        ) : (
          <div className="font-mono text-xs">
            {session.logs.length === 0 ? (
              <div className="text-center text-slate-400 text-sm py-16">
                ログがありません
              </div>
            ) : (
              session.logs.map((log, idx) => (
                <div
                  key={`${log.timestamp}-${idx}`}
                  className={clsx(
                    'px-4 py-1.5 border-b border-slate-100',
                    log.level === 'error' && 'bg-red-50',
                    log.level === 'warn' && 'bg-amber-50'
                  )}
                >
                  <span className="text-slate-400">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                  <span className={clsx(
                    'ml-2',
                    log.level === 'error' && 'text-red-600',
                    log.level === 'warn' && 'text-amber-600',
                    log.level === 'info' && 'text-primary-600',
                    log.level === 'debug' && 'text-slate-400'
                  )}>
                    [{log.source}]
                  </span>
                  <span className="ml-2 text-slate-700">{log.message}</span>
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input Area */}
      <div className="border-t border-slate-200 p-4 bg-white">
        <div className="max-w-3xl mx-auto">
          {/* Model & Executor Selectors */}
          {(availableModels || executorMode) && (
            <div className="flex items-center gap-3 mb-3">
              {/* Model */}
              {availableModels && selectedModel && onModelChange && (
                <div className="relative">
                  <button
                    onClick={() => setShowModelDropdown(!showModelDropdown)}
                    disabled={session.status === 'running'}
                    className="flex items-center gap-1 px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 rounded transition-colors disabled:opacity-50"
                  >
                    <span>{selectedModel}</span>
                    <ChevronDown size={12} />
                  </button>
                  {showModelDropdown && availableModels.length > 0 && (
                    <div className="absolute bottom-full left-0 mb-1 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[150px] max-h-[200px] overflow-y-auto z-50">
                      {availableModels.map((model) => (
                        <button
                          key={model}
                          onClick={() => {
                            onModelChange(model);
                            setShowModelDropdown(false);
                          }}
                          className={clsx(
                            'w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50',
                            model === selectedModel && 'bg-primary-50 text-primary-600'
                          )}
                        >
                          {model}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Executor Mode */}
              {executorMode && onExecutorModeChange && (
                <div className="relative">
                  <button
                    onClick={() => setShowExecutorDropdown(!showExecutorDropdown)}
                    className={clsx(
                      'flex items-center gap-1.5 px-2 py-1 text-xs rounded transition-colors',
                      executorMode === 'codex_only' && 'bg-green-100 text-green-700',
                      executorMode === 'claude_only' && 'bg-purple-100 text-purple-700',
                      executorMode === 'claude_direct' && 'bg-purple-200 text-purple-800',
                      executorMode === 'codex_direct' && 'bg-green-200 text-green-800',
                      executorMode === 'agent' && 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                    )}
                  >
                    <span className="w-2 h-2 rounded-full" style={{
                      backgroundColor:
                        executorMode === 'codex_only' ? '#22c55e' :
                        executorMode === 'claude_only' ? '#a855f7' :
                        executorMode === 'claude_direct' ? '#7c3aed' :
                        executorMode === 'codex_direct' ? '#16a34a' :
                        '#94a3b8'
                    }} />
                    <span>
                      {executorMode === 'codex_only' ? 'Codexのみ' :
                       executorMode === 'claude_only' ? 'Claudeのみ' :
                       executorMode === 'claude_direct' ? 'Claude Code' :
                       executorMode === 'codex_direct' ? 'Codex CLI' :
                       '自動'}
                    </span>
                    <ChevronDown size={12} />
                  </button>
                  {showExecutorDropdown && (
                    <div className="absolute bottom-full left-0 mb-1 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[160px] z-50">
                      <div className="px-2 py-1 text-[10px] text-slate-400 uppercase tracking-wide">Supervisor経由</div>
                      {([
                        { value: 'agent', label: '自動 (両方)', color: '#94a3b8' },
                        { value: 'codex_only', label: 'Codexのみ', color: '#22c55e' },
                        { value: 'claude_only', label: 'Claudeのみ', color: '#a855f7' },
                      ] as const).map((opt) => (
                        <button
                          key={opt.value}
                          onClick={() => {
                            onExecutorModeChange(opt.value);
                            setShowExecutorDropdown(false);
                          }}
                          className={clsx(
                            'w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50 flex items-center gap-2',
                            opt.value === executorMode && 'bg-primary-50'
                          )}
                        >
                          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: opt.color }} />
                          {opt.label}
                        </button>
                      ))}
                      <div className="border-t border-slate-100 mt-1 pt-1">
                        <div className="px-2 py-1 text-[10px] text-slate-400 uppercase tracking-wide">直接実行</div>
                        {([
                          { value: 'claude_direct', label: 'Claude Code', color: '#7c3aed' },
                          { value: 'codex_direct', label: 'Codex CLI', color: '#16a34a' },
                        ] as const).map((opt) => (
                          <button
                            key={opt.value}
                            onClick={() => {
                              onExecutorModeChange(opt.value);
                              setShowExecutorDropdown(false);
                            }}
                            className={clsx(
                              'w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50 flex items-center gap-2',
                              opt.value === executorMode && 'bg-primary-50'
                            )}
                          >
                            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: opt.color }} />
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Input */}
          <div className="relative">
            <textarea
              value={session.input}
              onChange={(e) => onUpdate({ input: e.target.value })}
              onKeyDown={handleKeyDown}
              placeholder={session.projectId ? "タスクを入力..." : "プロジェクトを選択してください"}
              disabled={!session.projectId || session.status === 'running'}
              className="w-full resize-none border border-slate-200 rounded-lg px-4 py-3 pr-14 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 min-h-[80px] disabled:bg-slate-50"
              rows={3}
            />
            <div className="absolute right-2 bottom-2">
              {session.status === 'running' ? (
                <button
                  onClick={handleStop}
                  className="p-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
                >
                  <Square size={16} />
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!session.input.trim() || !session.projectId}
                  className={clsx(
                    'p-2 rounded-lg transition-colors',
                    session.input.trim() && session.projectId
                      ? 'bg-primary-500 text-white hover:bg-primary-600'
                      : 'bg-slate-100 text-slate-400'
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

// --- Spec Agent Panel Component ---
function SpecAgentPanel({
  session,
  projects,
  onUpdate,
  onBack,
}: {
  session: AgentSession;
  projects: Project[];
  onUpdate: (updates: Partial<AgentSession>) => void;
  onBack?: () => void;
}) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [showProjectDropdown, setShowProjectDropdown] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const selectedProject = projects.find(p => p.project_id === session.projectId);

  // Auto-scroll when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session.messages.length]);

  // Load conversation on mount
  useEffect(() => {
    if (!session.runId) return;

    const loadConversation = async () => {
      try {
        const conversation = await fetchConversation(session.runId!);
        if (conversation) {
          const messages: ChatMessageData[] = conversation.messages.map(m => ({
            id: `${m.timestamp}-${Math.random()}`,
            type: m.role === 'user' ? 'user' : 'assistant',
            content: m.content,
            timestamp: m.timestamp,
            status: 'success',
          }));
          onUpdate({ messages });
        }
      } catch (error) {
        console.error('Failed to load conversation:', error);
      }
    };
    loadConversation();
  }, [session.runId]);

  const handleSend = async () => {
    if (!session.input.trim() || !session.runId) return;

    const userMessage: ChatMessageData = {
      id: `user-${Date.now()}`,
      type: 'user',
      content: session.input,
      timestamp: new Date().toISOString(),
    };

    onUpdate({
      messages: [...session.messages, userMessage],
      input: '',
    });

    setIsLoading(true);

    try {
      const response = await sendSpecMessage(session.runId, session.input);

      const assistantMessage: ChatMessageData = {
        id: `assistant-${Date.now()}`,
        type: 'assistant',
        content: response.message,
        timestamp: new Date().toISOString(),
        status: 'success',
      };

      onUpdate({
        messages: [...session.messages, userMessage, assistantMessage],
        status: response.completed ? 'completed' : session.status,
      });
    } catch (error) {
      const errorMessage: ChatMessageData = {
        id: `error-${Date.now()}`,
        type: 'assistant',
        content: error instanceof Error ? error.message : 'エラーが発生しました',
        timestamp: new Date().toISOString(),
        status: 'error',
      };

      onUpdate({
        messages: [...session.messages, userMessage, errorMessage],
        status: 'failed',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-slate-200 bg-purple-50">
        <div className="flex items-center gap-3">
          {onBack && (
            <button
              onClick={onBack}
              className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
            >
              <ArrowLeft size={20} />
            </button>
          )}

          {/* Mode Badge */}
          <span className="px-2 py-1 text-xs font-medium bg-purple-100 text-purple-700 rounded-full">
            仕様策定モード
          </span>

          {/* Project Selector */}
          <div className="relative">
            <button
              onClick={() => setShowProjectDropdown(!showProjectDropdown)}
              disabled={session.status === 'running'}
              className="flex items-center gap-2 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 rounded-lg transition-colors disabled:opacity-50"
            >
              <FolderOpen size={16} />
              <span className="truncate max-w-[200px]">
                {selectedProject?.name || 'Select Project'}
              </span>
              <ChevronDown size={14} />
            </button>
            {showProjectDropdown && (
              <div className="absolute top-full left-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[250px] max-h-[300px] overflow-y-auto z-50">
                {projects.map((project) => (
                  <button
                    key={project.project_id}
                    onClick={() => {
                      onUpdate({ projectId: project.project_id });
                      setShowProjectDropdown(false);
                    }}
                    className={clsx(
                      'w-full text-left px-3 py-2 text-sm hover:bg-slate-50',
                      project.project_id === session.projectId && 'bg-primary-50 text-primary-600'
                    )}
                  >
                    <div className="font-medium truncate">{project.name}</div>
                    <div className="text-xs text-slate-400 truncate">{project.repo_path}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Status */}
        <div className="flex items-center gap-2">
          {isLoading && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-yellow-100 text-yellow-700 rounded-full">
              <Loader2 size={10} className="animate-spin" />
              思考中
            </span>
          )}
          {session.status === 'completed' && (
            <span className="px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700 rounded-full">
              完了
            </span>
          )}
        </div>
      </div>

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto p-4 space-y-3">
          {session.messages.length === 0 ? (
            <div className="text-center text-slate-400 text-sm py-16">
              {session.runId
                ? '仕様についてチャットを開始してください'
                : 'まずプロジェクトを選択してください'}
            </div>
          ) : (
            session.messages.map((msg) => (
              <ChatMessage key={msg.id} message={msg} />
            ))
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input Area */}
      <div className="border-t border-slate-200 p-4 bg-white">
        <div className="max-w-3xl mx-auto">
          <div className="relative">
            <textarea
              value={session.input}
              onChange={(e) => onUpdate({ input: e.target.value })}
              onKeyDown={handleKeyDown}
              placeholder={session.runId ? "仕様について質問や指示を入力..." : "プロジェクトを選択してください"}
              disabled={!session.runId || isLoading}
              className="w-full resize-none border border-slate-200 rounded-lg px-4 py-3 pr-14 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 min-h-[80px] disabled:bg-slate-50"
              rows={3}
            />
            <div className="absolute right-2 bottom-2">
              <button
                onClick={handleSend}
                disabled={!session.input.trim() || !session.runId || isLoading}
                className={clsx(
                  'p-2 rounded-lg transition-colors',
                  session.input.trim() && session.runId && !isLoading
                    ? 'bg-purple-500 text-white hover:bg-purple-600'
                    : 'bg-slate-100 text-slate-400'
                )}
              >
                {isLoading ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Columns View Component (parallel mode) ---
function ColumnsView({
  sessions,
  projects,
  onUpdateSession,
  onAddSession,
  onAddFromHistory,
  onRemoveSession,
  onSwitchToTimeline,
  defaultModel,
  availableModels,
  defaultExecutorMode,
}: {
  sessions: AgentSession[];
  projects: Project[];
  onUpdateSession: (sessionId: string, updates: Partial<AgentSession>) => void;
  onAddSession: () => void;
  onAddFromHistory: (runId: string, projectId: string | undefined, goal: string) => void;
  onRemoveSession: (sessionId: string) => void;
  onSwitchToTimeline: () => void;
  defaultModel: string;
  availableModels: string[];
  defaultExecutorMode: ExecutorMode;
}) {
  const [showHistoryDropdown, setShowHistoryDropdown] = useState(false);
  const columnsRef = useRef<HTMLDivElement>(null);

  // Fetch runs for history dropdown
  const { data: runsData } = useQuery({
    queryKey: ['runs'],
    queryFn: fetchRuns,
  });
  const runs = runsData?.runs || [];

  // Handle mouse wheel for horizontal scroll
  useEffect(() => {
    const container = columnsRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      // Only handle if we're scrolling vertically and there's horizontal overflow
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && container.scrollWidth > container.clientWidth) {
        e.preventDefault();
        container.scrollLeft += e.deltaY;
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, []);

  return (
    <div className="flex flex-col h-full bg-slate-100">
      {/* Header */}
      <div className="flex items-center justify-between p-2 bg-white border-b border-slate-200">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-semibold text-slate-700">Parallel Agents</h1>
          <span className="text-xs text-slate-400">({sessions.length})</span>
        </div>
        <div className="flex items-center gap-2">
          {/* New Session */}
          <button
            onClick={onAddSession}
            className="flex items-center gap-1 px-2 py-1 text-xs text-primary-600 hover:bg-primary-50 rounded transition-colors"
          >
            <Plus size={14} />
            新規
          </button>

          {/* Add from History */}
          <div className="relative">
            <button
              onClick={() => setShowHistoryDropdown(!showHistoryDropdown)}
              className="flex items-center gap-1 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 rounded transition-colors"
            >
              <MessageSquare size={14} />
              履歴から
              <ChevronDown size={12} />
            </button>
            {showHistoryDropdown && (
              <div className="absolute top-full right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg py-1 w-[300px] max-h-[400px] overflow-y-auto z-50">
                {runs.length === 0 ? (
                  <div className="px-3 py-4 text-center text-slate-400 text-xs">
                    履歴がありません
                  </div>
                ) : (
                  runs.slice(0, 20).map((run) => {
                    const project = projects.find(p => p.project_id === run.project_id);
                    return (
                      <button
                        key={run.run_id}
                        onClick={() => {
                          onAddFromHistory(run.run_id, run.project_id, run.user_goal);
                          setShowHistoryDropdown(false);
                        }}
                        className="w-full text-left px-3 py-2 hover:bg-slate-50 border-b border-slate-50 last:border-0"
                      >
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-xs font-medium text-slate-700 truncate">
                            {project?.name || 'Unknown'}
                          </span>
                          <span className={clsx(
                            'px-1.5 py-0.5 text-[10px] rounded-full',
                            run.status === 'completed' && 'bg-green-100 text-green-700',
                            run.status === 'failed' && 'bg-red-100 text-red-700',
                            run.status === 'running' && 'bg-yellow-100 text-yellow-700',
                            run.status === 'interrupted' && 'bg-orange-100 text-orange-700'
                          )}>
                            {run.status}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 line-clamp-1">{run.user_goal}</p>
                        <p className="text-[10px] text-slate-400 mt-0.5">
                          {new Date(run.created_at).toLocaleString()}
                        </p>
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>

          <button
            onClick={onSwitchToTimeline}
            className="flex items-center gap-1 px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 rounded transition-colors"
          >
            <List size={14} />
            タイムライン
          </button>
        </div>
      </div>

      {/* Columns */}
      <div ref={columnsRef} className="flex-1 flex overflow-x-auto">
        {sessions.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <button
              onClick={onAddSession}
              className="flex flex-col items-center gap-2 p-6 text-slate-400 hover:text-slate-600 hover:bg-white rounded-lg border-2 border-dashed border-slate-300 hover:border-slate-400 transition-colors"
            >
              <Plus size={24} />
              <span className="text-sm">エージェントを追加</span>
            </button>
          </div>
        ) : (
          sessions.map((session) => (
            <AgentPanel
              key={session.id}
              session={session}
              projects={projects}
              onUpdate={(updates) => onUpdateSession(session.id, updates)}
              onClose={() => onRemoveSession(session.id)}
              availableModels={availableModels}
              selectedModel={session.selectedModel || defaultModel}
              onModelChange={(model) => onUpdateSession(session.id, { selectedModel: model })}
              executorMode={session.executorMode || defaultExecutorMode}
              onExecutorModeChange={(mode) => onUpdateSession(session.id, { executorMode: mode })}
            />
          ))
        )}

        {/* Add column button */}
        {sessions.length > 0 && (
          <button
            onClick={onAddSession}
            className="flex items-center justify-center min-w-[100px] text-slate-400 hover:text-slate-600 hover:bg-white rounded-lg border-2 border-dashed border-slate-300 hover:border-slate-400 transition-colors"
          >
            <Plus size={20} />
          </button>
        )}
      </div>
    </div>
  );
}

// --- Timeline View Component ---
function TimelineView({
  projects,
  onStartNew,
  onStartSpec,
  onOpenRun,
  onOpenOrphaned,
  onSwitchToParallel,
  selectedModel,
  availableModels,
  onModelChange,
  executorMode,
  onExecutorModeChange,
  maxContextTokens,
  onMaxContextTokensChange,
}: {
  projects: Project[];
  onStartNew: (projectId: string, goal: string) => void;
  onStartSpec: (projectId: string) => void;
  onOpenRun: (runId: string, projectId: string | undefined, goal: string, mode: RunMode) => void;
  onOpenOrphaned: (runId: string, firstMessage: string | null) => void;
  onSwitchToParallel: () => void;
  selectedModel: string;
  availableModels: string[];
  onModelChange: (model: string) => void;
  executorMode: ExecutorMode;
  onExecutorModeChange: (mode: ExecutorMode) => void;
  maxContextTokens: number;
  onMaxContextTokensChange: (tokens: number) => void;
}) {
  const queryClient = useQueryClient();
  const [newGoal, setNewGoal] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedMode, setSelectedMode] = useState<RunMode>('implementation');
  const [showProjectDropdown, setShowProjectDropdown] = useState(false);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showExecutorDropdown, setShowExecutorDropdown] = useState(false);
  const [showTokensDropdown, setShowTokensDropdown] = useState(false);

  // Token threshold options
  const tokenOptions = [
    { value: 50000, label: '50K' },
    { value: 100000, label: '100K' },
    { value: 150000, label: '150K' },
    { value: 200000, label: '200K' },
  ];

  // Fetch runs from database
  const { data: runsData, isLoading: runsLoading } = useQuery({
    queryKey: ['runs'],
    queryFn: fetchRuns,
    refetchInterval: 5000,
  });
  const runs = runsData?.runs || [];

  // Fetch orphaned sessions
  const { data: orphanedData } = useQuery({
    queryKey: ['orphanedSessions'],
    queryFn: fetchOrphanedSessions,
    refetchInterval: 10000,
  });
  const orphanedSessions = orphanedData?.sessions || [];

  const handleDeleteOrphaned = async (runId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await deleteOrphanedSession(runId);
    queryClient.invalidateQueries({ queryKey: ['orphanedSessions'] });
  };

  const selectedProject = projects.find(p => p.project_id === selectedProjectId);

  const handleSubmit = () => {
    if (!selectedProjectId) return;

    if (selectedMode === 'spec') {
      // Spec mode: start spec session (goal is optional)
      onStartSpec(selectedProjectId);
      setNewGoal('');
    } else {
      // Implementation mode: need goal
      if (!newGoal.trim()) return;
      onStartNew(selectedProjectId, newGoal);
      setNewGoal('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'running':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-yellow-100 text-yellow-700 rounded-full">
            <Loader2 size={10} className="animate-spin" />
            実行中
          </span>
        );
      case 'completed':
        return (
          <span className="px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700 rounded-full">
            完了
          </span>
        );
      case 'failed':
        return (
          <span className="px-2 py-0.5 text-xs font-medium bg-red-100 text-red-700 rounded-full">
            失敗
          </span>
        );
      case 'interrupted':
        return (
          <span className="px-2 py-0.5 text-xs font-medium bg-orange-100 text-orange-700 rounded-full">
            中断
          </span>
        );
      default:
        return (
          <span className="px-2 py-0.5 text-xs font-medium bg-slate-100 text-slate-500 rounded-full">
            待機中
          </span>
        );
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-slate-50">
      {/* Header */}
      <div className="p-4 bg-white border-b border-slate-200">
        <div className="max-w-2xl mx-auto space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <h1 className="text-lg font-semibold text-slate-800">Agents</h1>
            </div>
            <button
              onClick={onSwitchToParallel}
              className="flex items-center gap-1 px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 rounded transition-colors"
            >
              <Columns size={14} />
              並列モード
            </button>
          </div>
          {/* Project & Model Selectors */}
          <div className="flex flex-col sm:flex-row gap-2">
            {/* Project Selector */}
            <div className="relative flex-1">
              <button
                onClick={() => setShowProjectDropdown(!showProjectDropdown)}
                className="flex items-center gap-2 px-3 py-2.5 text-sm text-slate-700 bg-slate-50 hover:bg-slate-100 rounded-lg transition-colors w-full border border-slate-200"
              >
                <FolderOpen size={16} />
                <span className="truncate flex-1 text-left">
                  {selectedProject?.name || 'プロジェクトを選択'}
                </span>
                <ChevronDown size={16} />
              </button>
              {showProjectDropdown && (
                <div className="absolute top-full left-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg py-1 w-full max-h-[250px] overflow-y-auto z-50">
                  {projects.map((project) => (
                    <button
                      key={project.project_id}
                      onClick={() => {
                        setSelectedProjectId(project.project_id);
                        setShowProjectDropdown(false);
                      }}
                      className={clsx(
                        'w-full text-left px-3 py-2 text-sm hover:bg-slate-50',
                        project.project_id === selectedProjectId && 'bg-primary-50 text-primary-600'
                      )}
                    >
                      <div className="font-medium truncate">{project.name}</div>
                      <div className="text-xs text-slate-400 truncate">{project.repo_path}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Model Selector */}
            <div className="relative">
              <button
                onClick={() => setShowModelDropdown(!showModelDropdown)}
                className="flex items-center gap-1 px-3 py-2.5 text-xs text-slate-500 bg-slate-50 hover:bg-slate-100 rounded-lg transition-colors border border-slate-200"
              >
                <span>{selectedModel}</span>
                <ChevronDown size={14} />
              </button>
              {showModelDropdown && availableModels.length > 0 && (
                <div className="absolute top-full right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[150px] max-h-[200px] overflow-y-auto z-50">
                  {availableModels.map((model) => (
                    <button
                      key={model}
                      onClick={() => {
                        onModelChange(model);
                        setShowModelDropdown(false);
                      }}
                      className={clsx(
                        'w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50',
                        model === selectedModel && 'bg-primary-50 text-primary-600'
                      )}
                    >
                      {model}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Goal Input */}
          <div className="relative">
            {selectedMode === 'spec' ? (
              <div className="border border-purple-200 rounded-lg px-4 py-4 bg-purple-50">
                <p className="text-sm text-purple-700 mb-2">
                  仕様策定モードでは、AIとチャットしながら仕様書を作成できます。
                </p>
                <p className="text-xs text-purple-600">
                  プロジェクトを選択して開始ボタンをクリックしてください。
                </p>
              </div>
            ) : (
              <textarea
                value={newGoal}
                onChange={(e) => setNewGoal(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={selectedProjectId ? "タスクを入力してエージェントを開始..." : "まずプロジェクトを選択してください"}
                disabled={!selectedProjectId}
                className="w-full resize-none border border-slate-200 rounded-lg px-4 py-3 pb-12 pr-14 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 min-h-[100px] disabled:bg-slate-50 disabled:text-slate-400"
                rows={3}
              />
            )}
            <div className="absolute left-2 right-2 bottom-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                {/* Mode & Executor Selector */}
                <div className="relative">
                  <button
                    onClick={() => setShowExecutorDropdown(!showExecutorDropdown)}
                    className={clsx(
                      'flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-colors',
                      selectedMode === 'spec' && 'bg-amber-100 text-amber-700',
                      selectedMode === 'implementation' && executorMode === 'codex_only' && 'bg-green-100 text-green-700',
                      selectedMode === 'implementation' && executorMode === 'claude_only' && 'bg-purple-100 text-purple-700',
                      selectedMode === 'implementation' && executorMode === 'claude_direct' && 'bg-purple-200 text-purple-800',
                      selectedMode === 'implementation' && executorMode === 'codex_direct' && 'bg-green-200 text-green-800',
                      selectedMode === 'implementation' && executorMode === 'agent' && 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                    )}
                  >
                    <span className="w-2 h-2 rounded-full" style={{
                      backgroundColor:
                        selectedMode === 'spec' ? '#f59e0b' :
                        executorMode === 'codex_only' ? '#22c55e' :
                        executorMode === 'claude_only' ? '#a855f7' :
                        executorMode === 'claude_direct' ? '#7c3aed' :
                        executorMode === 'codex_direct' ? '#16a34a' :
                        '#94a3b8'
                    }} />
                    <span>
                      {selectedMode === 'spec' ? '仕様策定' :
                       executorMode === 'codex_only' ? 'Codexのみ' :
                       executorMode === 'claude_only' ? 'Claudeのみ' :
                       executorMode === 'claude_direct' ? 'Claude Code' :
                       executorMode === 'codex_direct' ? 'Codex CLI' :
                       '自動'}
                    </span>
                    <ChevronDown size={12} />
                  </button>
                  {showExecutorDropdown && (
                    <div className="absolute bottom-full left-0 mb-1 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[160px] z-50">
                      {/* Plan Mode */}
                      <button
                        onClick={() => {
                          setSelectedMode('spec');
                          setShowExecutorDropdown(false);
                        }}
                        className={clsx(
                          'w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50 flex items-center gap-2',
                          selectedMode === 'spec' && 'bg-amber-50'
                        )}
                      >
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: '#f59e0b' }} />
                        仕様策定 (Plan)
                      </button>
                      <div className="border-t border-slate-100 mt-1 pt-1">
                        <div className="px-2 py-1 text-[10px] text-slate-400 uppercase tracking-wide">実装 - Supervisor経由</div>
                        {([
                          { value: 'agent', label: '自動 (両方)', color: '#94a3b8' },
                          { value: 'codex_only', label: 'Codexのみ', color: '#22c55e' },
                          { value: 'claude_only', label: 'Claudeのみ', color: '#a855f7' },
                        ] as const).map((opt) => (
                          <button
                            key={opt.value}
                            onClick={() => {
                              setSelectedMode('implementation');
                              onExecutorModeChange(opt.value);
                              setShowExecutorDropdown(false);
                            }}
                            className={clsx(
                              'w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50 flex items-center gap-2',
                              selectedMode === 'implementation' && opt.value === executorMode && 'bg-primary-50'
                            )}
                          >
                            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: opt.color }} />
                            {opt.label}
                          </button>
                        ))}
                      </div>
                      <div className="border-t border-slate-100 mt-1 pt-1">
                        <div className="px-2 py-1 text-[10px] text-slate-400 uppercase tracking-wide">実装 - 直接実行</div>
                        {([
                          { value: 'claude_direct', label: 'Claude Code', color: '#7c3aed' },
                          { value: 'codex_direct', label: 'Codex CLI', color: '#16a34a' },
                        ] as const).map((opt) => (
                          <button
                            key={opt.value}
                            onClick={() => {
                              setSelectedMode('implementation');
                              onExecutorModeChange(opt.value);
                              setShowExecutorDropdown(false);
                            }}
                            className={clsx(
                              'w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50 flex items-center gap-2',
                              selectedMode === 'implementation' && opt.value === executorMode && 'bg-primary-50'
                            )}
                          >
                            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: opt.color }} />
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Token Threshold */}
                <div className="relative">
                  <button
                    onClick={() => setShowTokensDropdown(!showTokensDropdown)}
                    className="flex items-center gap-1 px-2 py-1 text-xs text-slate-500 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors"
                  >
                    <span>{Math.round(maxContextTokens / 1000)}K tokens</span>
                    <ChevronDown size={12} />
                  </button>
                  {showTokensDropdown && (
                    <div className="absolute bottom-full left-0 mb-1 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[100px] z-50">
                      {tokenOptions.map((opt) => (
                        <button
                          key={opt.value}
                          onClick={() => {
                            onMaxContextTokensChange(opt.value);
                            setShowTokensDropdown(false);
                          }}
                          className={clsx(
                            'w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50',
                            opt.value === maxContextTokens && 'bg-primary-50 text-primary-600'
                          )}
                        >
                          {opt.label} tokens
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Send Button */}
              {selectedMode === 'implementation' && (
                <button
                  onClick={handleSubmit}
                  disabled={!newGoal.trim() || !selectedProjectId}
                  className={clsx(
                    'p-2 rounded-lg transition-colors',
                    newGoal.trim() && selectedProjectId
                      ? 'bg-primary-500 text-white hover:bg-primary-600'
                      : 'bg-slate-100 text-slate-400'
                  )}
                >
                  <Send size={18} />
                </button>
              )}
              {selectedMode === 'spec' && (
                <button
                  onClick={handleSubmit}
                  disabled={!selectedProjectId}
                  className={clsx(
                    'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5',
                    selectedProjectId
                      ? 'bg-amber-500 text-white hover:bg-amber-600'
                      : 'bg-slate-100 text-slate-400'
                  )}
                >
                  <MessageSquare size={14} />
                  開始
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Run List */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto py-4 px-2">
          {/* Orphaned Sessions */}
          {orphanedSessions.length > 0 && (
            <div className="mb-6">
              <h3 className="px-3 text-xs font-semibold text-orange-600 uppercase tracking-wider mb-2">
                中断されたセッション
              </h3>
              <div className="bg-white rounded-lg border border-orange-200 divide-y divide-orange-100">
                {orphanedSessions.map((session) => (
                  <div
                    key={session.run_id}
                    onClick={() => onOpenOrphaned(session.run_id, session.first_message)}
                    className="px-4 py-3 hover:bg-orange-50 cursor-pointer"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          {getStatusBadge('interrupted')}
                          <span className="text-xs text-slate-400">{session.log_count} ログ</span>
                        </div>
                        <p className="text-sm text-slate-600 line-clamp-2">
                          {session.first_message || '(メッセージなし)'}
                        </p>
                        <p className="text-xs text-slate-400 mt-1">
                          {new Date(session.last_log).toLocaleString()}
                        </p>
                      </div>
                      <button
                        onClick={(e) => handleDeleteOrphaned(session.run_id, e)}
                        className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Run History */}
          <div>
            <h3 className="px-3 text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
              実行履歴
            </h3>
            {runsLoading ? (
              <div className="text-center text-slate-400 text-sm py-12 bg-white rounded-lg border border-slate-200">
                <Loader2 size={20} className="animate-spin mx-auto mb-2" />
                読み込み中...
              </div>
            ) : runs.length === 0 ? (
              <div className="text-center text-slate-400 text-sm py-12 bg-white rounded-lg border border-slate-200">
                履歴がありません
              </div>
            ) : (
              <div className="bg-white rounded-lg border border-slate-200 divide-y divide-slate-100">
                {(() => {
                  // Create a Map for O(1) project lookups (avoid N+1 pattern)
                  const projectMap = new Map(projects.map(p => [p.project_id, p]));
                  return runs.map((run) => {
                  const project = run.project_id ? projectMap.get(run.project_id) : undefined;
                  return (
                    <div
                      key={run.run_id}
                      onClick={() => onOpenRun(run.run_id, run.project_id, run.user_goal, run.mode || 'implementation')}
                      className="px-4 py-3 hover:bg-slate-50 cursor-pointer"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-medium text-slate-700 truncate">
                              {project?.name || 'Unknown Project'}
                            </span>
                            {run.mode === 'spec' && (
                              <span className="px-1.5 py-0.5 text-[10px] font-medium bg-purple-100 text-purple-700 rounded-full">
                                仕様
                              </span>
                            )}
                            {getStatusBadge(run.status)}
                          </div>
                          <p className="text-sm text-slate-600 line-clamp-2">
                            {run.user_goal || (run.mode === 'spec' ? '(仕様策定セッション)' : '(no goal)')}
                          </p>
                          <p className="text-xs text-slate-400 mt-1">
                            {new Date(run.created_at).toLocaleString()}
                          </p>
                        </div>
                      </div>
                    </div>
                  );
                });
                })()}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Main Page ---
type ViewMode = 'timeline' | 'single' | 'columns';

// Check if mobile device (screen width < 768px)
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth < 768
  );

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return isMobile;
}

export default function AgentsPage() {
  const isMobile = useIsMobile();
  const [viewModeInitialized, setViewModeInitialized] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('timeline');
  const [activeSession, setActiveSession] = useState<AgentSession | null>(null);
  const [parallelSessions, setParallelSessions] = useState<AgentSession[]>([]);
  const [parallelSessionsLoaded, setParallelSessionsLoaded] = useState(false);
  const [sessionsVersion, setSessionsVersion] = useState<number>(1);
  const [selectedModel, setSelectedModel] = useState('gpt-5.2');
  const [executorMode, setExecutorMode] = useState<ExecutorMode>('agent');
  const [maxContextTokens, setMaxContextTokens] = useState(150000);

  // Load projects
  const { data: projectsData } = useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
  });
  const projects = projectsData?.projects || [];

  // Load parallel sessions from server
  const { data: savedSessions } = useQuery({
    queryKey: ['parallelSessions'],
    queryFn: fetchParallelSessions,
    staleTime: Infinity, // Don't refetch automatically
  });

  // Save parallel sessions mutation with optimistic locking
  const queryClient = useQueryClient();
  const saveSessionsMutation = useMutation({
    mutationFn: ({ sessions, version }: { sessions: ParallelSession[]; version: number }) =>
      saveParallelSessions(sessions, version),
    onSuccess: (result) => {
      // Update local version after successful save
      setSessionsVersion(result.version);
    },
    onError: async (error) => {
      if (error instanceof ParallelSessionsConflictError) {
        // Conflict detected - refetch and let user know
        console.warn('Parallel sessions conflict detected, refetching...');
        await queryClient.invalidateQueries({ queryKey: ['parallelSessions'] });
      }
    },
  });

  // Create run mutation for starting new runs from timeline
  const createRunMutation = useMutation({
    mutationFn: (options: { goal: string; repoPath: string; projectId?: string; mode?: RunMode }) =>
      createRun(options),
  });

  // Initialize view mode based on device type (only once)
  useEffect(() => {
    if (!viewModeInitialized) {
      setViewMode(isMobile ? 'timeline' : 'columns');
      setViewModeInitialized(true);
    }
  }, [isMobile, viewModeInitialized]);

  // Load saved sessions on mount
  useEffect(() => {
    if (savedSessions?.sessions && !parallelSessionsLoaded) {
      const loadedSessions: AgentSession[] = savedSessions.sessions.map((s: ParallelSession) => ({
        id: s.id,
        projectId: s.projectId,
        runId: s.runId,
        mode: s.mode || 'implementation', // Use saved mode, fallback to implementation
        status: s.status,
        input: s.input,
        messages: [],
        logs: [],
        selectedModel: s.selectedModel,
        executorMode: s.executorMode,
        terminalSessionId: s.terminalSessionId,
      }));
      setParallelSessions(loadedSessions);
      setSessionsVersion(savedSessions.version || 1);
      setParallelSessionsLoaded(true);
    }
  }, [savedSessions, parallelSessionsLoaded]);

  // Save sessions to server when they change (debounced)
  useEffect(() => {
    if (!parallelSessionsLoaded) return;

    const timeout = setTimeout(() => {
      const sessionsToSave: ParallelSession[] = parallelSessions.map(s => ({
        id: s.id,
        projectId: s.projectId,
        runId: s.runId,
        mode: s.mode,
        status: s.status,
        input: s.input,
        selectedModel: s.selectedModel,
        executorMode: s.executorMode,
        terminalSessionId: s.terminalSessionId,
      }));
      saveSessionsMutation.mutate({ sessions: sessionsToSave, version: sessionsVersion });
    }, 500);

    return () => clearTimeout(timeout);
  }, [parallelSessions, parallelSessionsLoaded, sessionsVersion]);

  // Load copilot models
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
  });

  const availableModels = (copilotModels?.models ?? []).map((m: CopilotModel) => m.id);

  // Sync settings
  useEffect(() => {
    if (settings?.dag_model) setSelectedModel(settings.dag_model);
  }, [settings?.dag_model]);

  useEffect(() => {
    if (settings?.executor_mode) setExecutorMode(settings.executor_mode);
  }, [settings?.executor_mode]);

  useEffect(() => {
    if (settings?.max_context_tokens) setMaxContextTokens(settings.max_context_tokens);
  }, [settings?.max_context_tokens]);

  const handleModelChange = (model: string) => {
    setSelectedModel(model);
    updateSettingsMutation.mutate({ dag_model: model });
  };

  const handleExecutorModeChange = (mode: ExecutorMode) => {
    setExecutorMode(mode);
    updateSettingsMutation.mutate({ executor_mode: mode });
  };

  const handleMaxContextTokensChange = (tokens: number) => {
    setMaxContextTokens(tokens);
    updateSettingsMutation.mutate({ max_context_tokens: tokens });
  };

  // Start new agent from timeline (implementation mode)
  const startNewFromTimeline = (projectId: string, goal: string) => {
    const project = projects.find(p => p.project_id === projectId);
    if (!project) return;

    const newSession: AgentSession = {
      id: `session-${Date.now()}`,
      projectId,
      runId: null,
      mode: 'implementation',
      status: 'idle',
      input: '',
      messages: [],
      logs: [],
    };

    createRunMutation.mutate(
      { goal, repoPath: project.repo_path, projectId, mode: 'implementation' },
      {
        onSuccess: (data) => {
          setActiveSession({
            ...newSession,
            runId: data.run_id,
            status: 'running',
            messages: [{
              id: `user-${Date.now()}`,
              type: 'user',
              content: goal,
              timestamp: new Date().toISOString(),
            }],
          });
          setViewMode('single');
          queryClient.invalidateQueries({ queryKey: ['runs'] });
        },
      }
    );
  };

  // Start spec mode session from timeline
  const startSpecFromTimeline = (projectId: string) => {
    const project = projects.find(p => p.project_id === projectId);
    if (!project) return;

    const newSession: AgentSession = {
      id: `session-${Date.now()}`,
      projectId,
      runId: null,
      mode: 'spec',
      status: 'idle',
      input: '',
      messages: [],
      logs: [],
    };

    createRunMutation.mutate(
      { goal: '仕様策定', repoPath: project.repo_path, projectId, mode: 'spec' },
      {
        onSuccess: (data) => {
          setActiveSession({
            ...newSession,
            runId: data.run_id,
            status: 'running',
          });
          setViewMode('single');
          queryClient.invalidateQueries({ queryKey: ['runs'] });
        },
      }
    );
  };

  // Open existing run
  const openRunFromTimeline = async (runId: string, projectId: string | undefined, goal: string, mode: RunMode = 'implementation') => {
    try {
      const run = await fetchRun(runId);
      const runMode = run.mode || mode;
      const status: AgentStatus = run.status === 'running' || run.status === 'pending'
        ? 'running'
        : run.status === 'completed'
        ? 'completed'
        : run.status === 'failed'
        ? 'failed'
        : run.status === 'interrupted'
        ? 'interrupted'
        : 'idle';

      if (runMode === 'spec') {
        // Spec mode: load conversation
        const conversation = await fetchConversation(runId);
        const messages: ChatMessageData[] = conversation?.messages.map(m => ({
          id: `${m.timestamp}-${Math.random()}`,
          type: m.role === 'user' ? 'user' : 'assistant',
          content: m.content,
          timestamp: m.timestamp,
          status: 'success',
        })) || [];

        setActiveSession({
          id: `session-${Date.now()}`,
          projectId: projectId || null,
          runId,
          mode: 'spec',
          status,
          input: '',
          messages,
          logs: [],
        });
      } else {
        // Implementation mode: load logs
        const { logs } = await fetchLogs(runId);

        const messages: ChatMessageData[] = [
          {
            id: `user-${Date.now()}`,
            type: 'user',
            content: goal,
            timestamp: run.created_at,
          },
          ...logs
            .filter(l => l.level === 'info' || l.level === 'warn' || l.level === 'error')
            .map(l => ({
              id: `${l.timestamp}-${Math.random()}`,
              type: 'assistant' as const,
              content: l.message,
              timestamp: l.timestamp,
              status: l.level === 'error' ? 'error' as const : 'success' as const,
              executor: (l.source === 'claude' || l.source === 'codex')
                ? l.source as 'claude' | 'codex'
                : undefined,
            })),
        ];

        setActiveSession({
          id: `session-${Date.now()}`,
          projectId: projectId || null,
          runId,
          mode: 'implementation',
          status,
          input: '',
          messages,
          logs,
        });
      }
      setViewMode('single');
    } catch (error) {
      console.error('Failed to open run:', error);
    }
  };

  // Open orphaned session
  const openOrphanedFromTimeline = async (runId: string, _firstMessage: string | null) => {
    try {
      const { logs } = await fetchLogs(runId);

      const messages: ChatMessageData[] = logs
        .filter(l => l.level === 'info' || l.level === 'warn' || l.level === 'error')
        .map(l => ({
          id: `${l.timestamp}-${Math.random()}`,
          type: 'assistant' as const,
          content: l.message,
          timestamp: l.timestamp,
          status: l.level === 'error' ? 'error' as const : 'success' as const,
          executor: (l.source === 'claude' || l.source === 'codex')
            ? l.source as 'claude' | 'codex'
            : undefined,
        }));

      setActiveSession({
        id: `session-${Date.now()}`,
        projectId: null,
        runId: null,
        mode: 'implementation',
        status: 'interrupted',
        input: '',
        messages,
        logs,
      });
      setViewMode('single');
    } catch (error) {
      console.error('Failed to open orphaned session:', error);
    }
  };

  const updateActiveSession = (updates: Partial<AgentSession>) => {
    if (activeSession) {
      setActiveSession({ ...activeSession, ...updates });
    }
  };

  // Parallel mode handlers
  const addParallelSession = () => {
    const newSession: AgentSession = {
      id: `session-${Date.now()}`,
      projectId: null,
      runId: null,
      mode: 'implementation',
      status: 'idle',
      input: '',
      messages: [],
      logs: [],
    };
    setParallelSessions([...parallelSessions, newSession]);
  };

  const removeParallelSession = (sessionId: string) => {
    setParallelSessions(parallelSessions.filter(s => s.id !== sessionId));
  };

  const updateParallelSession = (sessionId: string, updates: Partial<AgentSession>) => {
    setParallelSessions(parallelSessions.map(s =>
      s.id === sessionId ? { ...s, ...updates } : s
    ));
  };

  // Add session from history to parallel mode
  const addFromHistoryToParallel = async (runId: string, projectId: string | undefined, goal: string) => {
    try {
      const run = await fetchRun(runId);
      const status: AgentStatus = run.status === 'running' || run.status === 'pending'
        ? 'running'
        : run.status === 'completed'
        ? 'completed'
        : run.status === 'failed'
        ? 'failed'
        : run.status === 'interrupted'
        ? 'interrupted'
        : 'idle';

      const { logs } = await fetchLogs(runId);

      const messages: ChatMessageData[] = [
        {
          id: `user-${Date.now()}`,
          type: 'user',
          content: goal,
          timestamp: run.created_at,
        },
        ...logs
          .filter(l => l.level === 'info' || l.level === 'warn' || l.level === 'error')
          .map(l => ({
            id: `${l.timestamp}-${Math.random()}`,
            type: 'assistant' as const,
            content: l.message,
            timestamp: l.timestamp,
            status: l.level === 'error' ? 'error' as const : 'success' as const,
            executor: (l.source === 'claude' || l.source === 'codex')
              ? l.source as 'claude' | 'codex'
              : undefined,
          })),
      ];

      const newSession: AgentSession = {
        id: `session-${Date.now()}`,
        projectId: projectId || null,
        runId,
        mode: run.mode || 'implementation',
        status,
        input: '',
        messages,
        logs,
      };

      setParallelSessions([...parallelSessions, newSession]);
    } catch (error) {
      console.error('Failed to load run for parallel:', error);
    }
  };

  const switchToParallel = () => {
    setViewMode('columns');
    if (parallelSessions.length === 0) {
      addParallelSession();
    }
  };

  const switchToTimeline = () => {
    setViewMode('timeline');
    setActiveSession(null);
  };

  return (
    <div className="h-[calc(100vh-64px)] lg:h-screen flex flex-col">
      {viewMode === 'single' && activeSession ? (
        activeSession.mode === 'spec' ? (
          <SpecAgentPanel
            session={activeSession}
            projects={projects}
            onUpdate={updateActiveSession}
            onBack={() => {
              setActiveSession(null);
              setViewMode('timeline');
            }}
          />
        ) : (
          <AgentPanel
            session={activeSession}
            projects={projects}
            onUpdate={updateActiveSession}
            onBack={() => {
              setActiveSession(null);
              setViewMode('timeline');
            }}
            availableModels={availableModels}
            selectedModel={selectedModel}
            onModelChange={handleModelChange}
            executorMode={executorMode}
            onExecutorModeChange={handleExecutorModeChange}
          />
        )
      ) : viewMode === 'columns' ? (
        <ColumnsView
          sessions={parallelSessions}
          projects={projects}
          onUpdateSession={updateParallelSession}
          onAddSession={addParallelSession}
          onAddFromHistory={addFromHistoryToParallel}
          onRemoveSession={removeParallelSession}
          onSwitchToTimeline={switchToTimeline}
          defaultModel={selectedModel}
          availableModels={availableModels}
          defaultExecutorMode={executorMode}
        />
      ) : (
        <TimelineView
          projects={projects}
          onStartNew={startNewFromTimeline}
          onStartSpec={startSpecFromTimeline}
          onOpenRun={openRunFromTimeline}
          onOpenOrphaned={openOrphanedFromTimeline}
          onSwitchToParallel={switchToParallel}
          selectedModel={selectedModel}
          availableModels={availableModels}
          onModelChange={handleModelChange}
          executorMode={executorMode}
          onExecutorModeChange={handleExecutorModeChange}
          maxContextTokens={maxContextTokens}
          onMaxContextTokensChange={handleMaxContextTokensChange}
        />
      )}
    </div>
  );
}
