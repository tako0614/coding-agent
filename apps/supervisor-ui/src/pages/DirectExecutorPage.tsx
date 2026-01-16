import { useEffect, useState, useRef } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  Send,
  Loader2,
  ChevronDown,
  FolderOpen,
  Plus,
  Trash2,
  Play,
  Square,
  Terminal,
  Code,
  FileEdit,
  Check,
  AlertCircle,
} from 'lucide-react';

import {
  fetchDirectExecutorSessions,
  createDirectExecutorSession,
  deleteDirectExecutorSession,
  subscribeToDirectExecutorQuery,
  fetchProjects,
  type DirectExecutorType,
  type DirectExecutorMessage,
  type ClaudeMessage,
  type CodexMessage,
  type Project,
} from '../lib/api';
import clsx from 'clsx';

// --- Types ---
interface ChatMessage {
  id: string;
  type: 'user' | 'assistant' | 'tool' | 'system' | 'result';
  content: string;
  timestamp: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  isError?: boolean;
  executor?: DirectExecutorType;
}

// --- Message Component ---
function MessageItem({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);

  if (message.type === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] bg-primary-500 text-white rounded-lg px-4 py-2">
          <p className="text-sm whitespace-pre-wrap">{message.content}</p>
          <p className="text-xs text-primary-200 mt-1">
            {new Date(message.timestamp).toLocaleTimeString()}
          </p>
        </div>
      </div>
    );
  }

  if (message.type === 'tool') {
    return (
      <div className="flex justify-start">
        <div className="max-w-[90%] bg-slate-100 rounded-lg px-4 py-2 border border-slate-200">
          <div className="flex items-center gap-2 mb-1">
            {message.toolName === 'Bash' && <Terminal size={14} className="text-green-600" />}
            {(message.toolName === 'Edit' || message.toolName === 'Write') && <FileEdit size={14} className="text-blue-600" />}
            {message.toolName === 'Read' && <Code size={14} className="text-purple-600" />}
            {!['Bash', 'Edit', 'Write', 'Read'].includes(message.toolName || '') && <Code size={14} className="text-slate-600" />}
            <span className="text-xs font-medium text-slate-700">{message.toolName}</span>
            {message.isError ? (
              <AlertCircle size={12} className="text-red-500" />
            ) : message.toolOutput ? (
              <Check size={12} className="text-green-500" />
            ) : (
              <Loader2 size={12} className="text-slate-400 animate-spin" />
            )}
          </div>
          {message.toolInput && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1"
            >
              <ChevronDown size={12} className={clsx('transition-transform', expanded && 'rotate-180')} />
              {expanded ? 'Hide details' : 'Show details'}
            </button>
          )}
          {expanded && message.toolInput && (
            <pre className="mt-2 text-xs bg-slate-200 p-2 rounded overflow-x-auto max-h-40">
              {JSON.stringify(message.toolInput, null, 2)}
            </pre>
          )}
          {message.toolOutput && (
            <pre className={clsx(
              'mt-2 text-xs p-2 rounded overflow-x-auto max-h-40',
              message.isError ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'
            )}>
              {message.toolOutput.length > 500 ? message.toolOutput.slice(0, 500) + '...' : message.toolOutput}
            </pre>
          )}
        </div>
      </div>
    );
  }

  if (message.type === 'system') {
    return (
      <div className="flex justify-center">
        <div className={clsx(
          'text-xs px-3 py-1 rounded-full',
          message.isError ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-500'
        )}>
          {message.content}
        </div>
      </div>
    );
  }

  if (message.type === 'result') {
    return (
      <div className="flex justify-start">
        <div className="max-w-[90%] bg-green-50 border border-green-200 rounded-lg px-4 py-2">
          <div className="flex items-center gap-2 mb-1">
            <Check size={14} className="text-green-600" />
            <span className="text-xs font-medium text-green-700">Result</span>
          </div>
          <p className="text-sm text-green-800 whitespace-pre-wrap">{message.content}</p>
        </div>
      </div>
    );
  }

  // Assistant message
  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] bg-white border border-slate-200 rounded-lg px-4 py-2">
        <div className="flex items-center gap-2 mb-1">
          <span className={clsx(
            'text-xs px-2 py-0.5 rounded-full',
            message.executor === 'claude' ? 'bg-purple-100 text-purple-700' : 'bg-green-100 text-green-700'
          )}>
            {message.executor === 'claude' ? 'Claude' : 'Codex'}
          </span>
        </div>
        <p className="text-sm text-slate-700 whitespace-pre-wrap">{message.content}</p>
        <p className="text-xs text-slate-400 mt-1">
          {new Date(message.timestamp).toLocaleTimeString()}
        </p>
      </div>
    </div>
  );
}

// --- Main Page ---
export default function DirectExecutorPage() {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [executorType, setExecutorType] = useState<DirectExecutorType>('claude');
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [showExecutorDropdown, setShowExecutorDropdown] = useState(false);
  const [showProjectDropdown, setShowProjectDropdown] = useState(false);
  const abortRef = useRef<(() => void) | null>(null);

  // Fetch projects
  const { data: projectsData } = useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
  });
  const projects = projectsData?.projects || [];

  // Fetch sessions
  const { data: sessionsData, refetch: refetchSessions } = useQuery({
    queryKey: ['directExecutorSessions'],
    queryFn: fetchDirectExecutorSessions,
    refetchInterval: 10000,
  });
  const sessions = sessionsData?.sessions || [];

  // Find active session
  const activeSession = sessions.find(s => s.session_id === activeSessionId);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // Create session mutation
  const createSessionMutation = useMutation({
    mutationFn: ({ type, dir }: { type: DirectExecutorType; dir: string }) =>
      createDirectExecutorSession(type, dir),
    onSuccess: (session) => {
      setActiveSessionId(session.session_id);
      setMessages([{
        id: `system-${Date.now()}`,
        type: 'system',
        content: `Session created with ${session.executor_type === 'claude' ? 'Claude Code' : 'Codex'}`,
        timestamp: new Date().toISOString(),
      }]);
      refetchSessions();
    },
  });

  // Delete session mutation
  const deleteSessionMutation = useMutation({
    mutationFn: deleteDirectExecutorSession,
    onSuccess: () => {
      if (activeSessionId) {
        setActiveSessionId(null);
        setMessages([]);
      }
      refetchSessions();
    },
  });

  // Handle creating new session
  const handleCreateSession = () => {
    if (!cwd.trim()) return;
    createSessionMutation.mutate({ type: executorType, dir: cwd });
  };

  // Handle sending query
  const handleSend = () => {
    if (!prompt.trim() || !activeSessionId || isRunning) return;

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      type: 'user',
      content: prompt,
      timestamp: new Date().toISOString(),
    };

    setMessages(prev => [...prev, userMessage]);
    setPrompt('');
    setIsRunning(true);

    // Track current tool for pairing tool_use with tool_result
    let currentToolUseId: string | null = null;
    const pendingTools = new Map<string, ChatMessage>();

    const abort = subscribeToDirectExecutorQuery(
      activeSessionId,
      prompt,
      (msg: DirectExecutorMessage) => {
        const m = msg.message;

        if (msg.executor === 'claude') {
          const cm = m as ClaudeMessage;

          if (cm.type === 'system') {
            setMessages(prev => [...prev, {
              id: `system-${Date.now()}-${Math.random()}`,
              type: 'system',
              content: cm.message || (cm.subtype === 'init' ? 'Connected' : 'System event'),
              timestamp: msg.timestamp,
              isError: cm.subtype === 'error',
            }]);
          } else if (cm.type === 'assistant' && cm.content) {
            setMessages(prev => [...prev, {
              id: `assistant-${Date.now()}-${Math.random()}`,
              type: 'assistant',
              content: cm.content!,
              timestamp: msg.timestamp,
              executor: 'claude',
            }]);
          } else if (cm.type === 'tool_use') {
            currentToolUseId = cm.tool_use_id || null;
            const toolMsg: ChatMessage = {
              id: `tool-${cm.tool_use_id || Date.now()}`,
              type: 'tool',
              content: '',
              timestamp: msg.timestamp,
              toolName: cm.tool_name,
              toolInput: cm.tool_input,
              executor: 'claude',
            };
            if (currentToolUseId) {
              pendingTools.set(currentToolUseId, toolMsg);
            }
            setMessages(prev => [...prev, toolMsg]);
          } else if (cm.type === 'tool_result') {
            const toolId = cm.tool_use_id || currentToolUseId;
            if (toolId) {
              setMessages(prev => prev.map(msg => {
                if (msg.id === `tool-${toolId}`) {
                  return {
                    ...msg,
                    toolOutput: cm.content || '',
                    isError: cm.is_error,
                  };
                }
                return msg;
              }));
            }
          } else if (cm.type === 'result') {
            setMessages(prev => [...prev, {
              id: `result-${Date.now()}`,
              type: 'result',
              content: cm.result || 'Completed',
              timestamp: msg.timestamp,
              executor: 'claude',
            }]);
          }
        } else {
          // Codex
          const cx = m as CodexMessage;

          if (cx.type === 'text' && cx.content) {
            setMessages(prev => [...prev, {
              id: `assistant-${Date.now()}-${Math.random()}`,
              type: 'assistant',
              content: cx.content!,
              timestamp: msg.timestamp,
              executor: 'codex',
            }]);
          } else if (cx.type === 'tool_call') {
            const toolMsg: ChatMessage = {
              id: `tool-${cx.tool_call_id || Date.now()}`,
              type: 'tool',
              content: '',
              timestamp: msg.timestamp,
              toolName: cx.tool_name,
              toolInput: cx.arguments,
              executor: 'codex',
            };
            if (cx.tool_call_id) {
              pendingTools.set(cx.tool_call_id, toolMsg);
            }
            setMessages(prev => [...prev, toolMsg]);
          } else if (cx.type === 'tool_result') {
            const toolId = cx.tool_call_id;
            if (toolId) {
              setMessages(prev => prev.map(msg => {
                if (msg.id === `tool-${toolId}`) {
                  return {
                    ...msg,
                    toolOutput: cx.output || '',
                    isError: cx.is_error,
                  };
                }
                return msg;
              }));
            }
          } else if (cx.type === 'file_change') {
            setMessages(prev => [...prev, {
              id: `system-${Date.now()}-${Math.random()}`,
              type: 'system',
              content: `File ${cx.action}: ${cx.path}`,
              timestamp: msg.timestamp,
            }]);
          } else if (cx.type === 'complete') {
            setMessages(prev => [...prev, {
              id: `result-${Date.now()}`,
              type: 'result',
              content: cx.result || 'Completed',
              timestamp: msg.timestamp,
              executor: 'codex',
            }]);
          }
        }
      },
      (error) => {
        setMessages(prev => [...prev, {
          id: `error-${Date.now()}`,
          type: 'system',
          content: error.message,
          timestamp: new Date().toISOString(),
          isError: true,
        }]);
        setIsRunning(false);
      },
      () => {
        setIsRunning(false);
      }
    );

    abortRef.current = abort;
  };

  // Handle stop
  const handleStop = () => {
    if (abortRef.current) {
      abortRef.current();
      abortRef.current = null;
    }
    setIsRunning(false);
    setMessages(prev => [...prev, {
      id: `system-${Date.now()}`,
      type: 'system',
      content: 'Execution stopped',
      timestamp: new Date().toISOString(),
    }]);
  };

  // Handle key down
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Select project
  const handleSelectProject = (project: Project) => {
    setCwd(project.repo_path);
    setShowProjectDropdown(false);
  };

  return (
    <div className="h-[calc(100vh-64px)] lg:h-screen flex flex-col bg-slate-50">
      {/* Header */}
      <div className="p-4 bg-white border-b border-slate-200">
        <div className="max-w-3xl mx-auto space-y-3">
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-semibold text-slate-800">Direct Executor</h1>
            <div className="flex items-center gap-2">
              {/* Executor Type Selector */}
              <div className="relative">
                <button
                  onClick={() => setShowExecutorDropdown(!showExecutorDropdown)}
                  disabled={isRunning}
                  className={clsx(
                    'flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg transition-colors',
                    executorType === 'claude' ? 'bg-purple-100 text-purple-700' : 'bg-green-100 text-green-700',
                    isRunning && 'opacity-50 cursor-not-allowed'
                  )}
                >
                  <span className={clsx(
                    'w-2 h-2 rounded-full',
                    executorType === 'claude' ? 'bg-purple-500' : 'bg-green-500'
                  )} />
                  {executorType === 'claude' ? 'Claude Code' : 'Codex'}
                  <ChevronDown size={14} />
                </button>
                {showExecutorDropdown && (
                  <div className="absolute top-full right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[150px] z-50">
                    <button
                      onClick={() => { setExecutorType('claude'); setShowExecutorDropdown(false); }}
                      className={clsx(
                        'w-full text-left px-3 py-2 text-sm hover:bg-slate-50 flex items-center gap-2',
                        executorType === 'claude' && 'bg-purple-50'
                      )}
                    >
                      <span className="w-2 h-2 rounded-full bg-purple-500" />
                      Claude Code
                    </button>
                    <button
                      onClick={() => { setExecutorType('codex'); setShowExecutorDropdown(false); }}
                      className={clsx(
                        'w-full text-left px-3 py-2 text-sm hover:bg-slate-50 flex items-center gap-2',
                        executorType === 'codex' && 'bg-green-50'
                      )}
                    >
                      <span className="w-2 h-2 rounded-full bg-green-500" />
                      Codex
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Working Directory & Session */}
          <div className="flex flex-col sm:flex-row gap-2">
            {/* Project/CWD Selector */}
            <div className="relative flex-1">
              <div className="flex gap-2">
                <button
                  onClick={() => setShowProjectDropdown(!showProjectDropdown)}
                  disabled={isRunning}
                  className="flex items-center gap-2 px-3 py-2 text-sm text-slate-700 bg-slate-50 hover:bg-slate-100 rounded-lg border border-slate-200 disabled:opacity-50"
                >
                  <FolderOpen size={16} />
                  <ChevronDown size={14} />
                </button>
                <input
                  type="text"
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  placeholder="Working directory..."
                  disabled={isRunning}
                  className="flex-1 px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-slate-50"
                />
              </div>
              {showProjectDropdown && projects.length > 0 && (
                <div className="absolute top-full left-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg py-1 w-full max-h-[250px] overflow-y-auto z-50">
                  {projects.map((project) => (
                    <button
                      key={project.project_id}
                      onClick={() => handleSelectProject(project)}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50"
                    >
                      <div className="font-medium truncate">{project.name}</div>
                      <div className="text-xs text-slate-400 truncate">{project.repo_path}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Create/Delete Session */}
            {!activeSession ? (
              <button
                onClick={handleCreateSession}
                disabled={!cwd.trim() || createSessionMutation.isPending}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-primary-500 hover:bg-primary-600 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {createSessionMutation.isPending ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Plus size={16} />
                )}
                New Session
              </button>
            ) : (
              <button
                onClick={() => deleteSessionMutation.mutate(activeSession.session_id)}
                disabled={isRunning || deleteSessionMutation.isPending}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-lg transition-colors disabled:opacity-50"
              >
                <Trash2 size={16} />
                End Session
              </button>
            )}
          </div>

          {/* Sessions List */}
          {sessions.length > 0 && (
            <div className="flex items-center gap-2 overflow-x-auto pb-1">
              <span className="text-xs text-slate-500 shrink-0">Sessions:</span>
              {sessions.map((session) => (
                <button
                  key={session.session_id}
                  onClick={() => {
                    setActiveSessionId(session.session_id);
                    setCwd(session.cwd);
                    setExecutorType(session.executor_type);
                    setMessages([{
                      id: `system-${Date.now()}`,
                      type: 'system',
                      content: `Switched to ${session.executor_type === 'claude' ? 'Claude' : 'Codex'} session`,
                      timestamp: new Date().toISOString(),
                    }]);
                  }}
                  className={clsx(
                    'flex items-center gap-1.5 px-2 py-1 text-xs rounded-lg shrink-0 transition-colors',
                    session.session_id === activeSessionId
                      ? session.executor_type === 'claude' ? 'bg-purple-100 text-purple-700' : 'bg-green-100 text-green-700'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  )}
                >
                  <span className={clsx(
                    'w-1.5 h-1.5 rounded-full',
                    session.executor_type === 'claude' ? 'bg-purple-500' : 'bg-green-500'
                  )} />
                  {session.executor_type === 'claude' ? 'Claude' : 'Codex'}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto p-4 space-y-3">
          {!activeSession ? (
            <div className="text-center text-slate-400 text-sm py-16">
              <Terminal size={48} className="mx-auto mb-4 opacity-50" />
              <p>Select a working directory and create a session to start</p>
            </div>
          ) : messages.length === 0 ? (
            <div className="text-center text-slate-400 text-sm py-16">
              <Play size={48} className="mx-auto mb-4 opacity-50" />
              <p>Send a prompt to start using {executorType === 'claude' ? 'Claude Code' : 'Codex'}</p>
            </div>
          ) : (
            messages.map((msg) => <MessageItem key={msg.id} message={msg} />)
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input Area */}
      <div className="border-t border-slate-200 p-4 bg-white">
        <div className="max-w-3xl mx-auto">
          <div className="relative">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={activeSession ? "Enter your prompt..." : "Create a session first..."}
              disabled={!activeSession || isRunning}
              className="w-full resize-none border border-slate-200 rounded-lg px-4 py-3 pr-14 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 min-h-[80px] disabled:bg-slate-50 disabled:text-slate-400"
              rows={3}
            />
            <div className="absolute right-2 bottom-2">
              {isRunning ? (
                <button
                  onClick={handleStop}
                  className="p-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
                >
                  <Square size={16} />
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!prompt.trim() || !activeSession}
                  className={clsx(
                    'p-2 rounded-lg transition-colors',
                    prompt.trim() && activeSession
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
