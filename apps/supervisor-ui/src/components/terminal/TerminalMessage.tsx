import { useState } from 'react';
import clsx from 'clsx';
import {
  ChevronRight,
  ChevronDown,
  Check,
  X,
  Loader2,
  FileText,
  Terminal,
  Search,
  Pencil,
  Eye,
  Zap,
  FolderTree,
  GitBranch,
} from 'lucide-react';

export type TerminalMessageType =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'result'
  | 'system'
  | 'error'
  | 'thinking';

export interface TerminalMessageData {
  id: string;
  type: TerminalMessageType;
  content: string;
  timestamp: string;
  // Tool info
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  isError?: boolean;
  // Status
  status?: 'pending' | 'running' | 'success' | 'error';
  // Executor
  executor?: 'claude' | 'codex' | 'supervisor';
  // Metadata
  metadata?: Record<string, unknown>;
}

// Get icon for tool
function getToolIcon(name: string) {
  const lower = name.toLowerCase();
  if (lower.includes('read') || lower.includes('glob')) return Eye;
  if (lower.includes('write') || lower.includes('edit')) return Pencil;
  if (lower.includes('bash') || lower.includes('shell')) return Terminal;
  if (lower.includes('grep') || lower.includes('search')) return Search;
  if (lower.includes('list') || lower.includes('tree')) return FolderTree;
  if (lower.includes('git')) return GitBranch;
  if (lower.includes('file')) return FileText;
  return Zap;
}

// Format timestamp
function formatTime(timestamp: string) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

// User input message
function UserMessage({ message }: { message: TerminalMessageData }) {
  return (
    <div className="group">
      <div className="flex items-start gap-3 py-3 px-4">
        <span className="text-emerald-400 font-bold shrink-0">{'>'}</span>
        <div className="flex-1 min-w-0">
          <pre className="text-slate-100 whitespace-pre-wrap font-mono text-sm">
            {message.content}
          </pre>
        </div>
        <span className="text-slate-600 text-xs font-mono opacity-0 group-hover:opacity-100 transition-opacity">
          {formatTime(message.timestamp)}
        </span>
      </div>
    </div>
  );
}

// Assistant response
function AssistantMessage({ message }: { message: TerminalMessageData }) {
  const isThinking = message.type === 'thinking' || message.status === 'running';
  const executorColor = message.executor === 'codex'
    ? 'text-green-400'
    : message.executor === 'claude'
    ? 'text-purple-400'
    : 'text-blue-400';

  return (
    <div className="group border-l-2 border-slate-700 hover:border-slate-600 transition-colors">
      <div className="flex items-start gap-3 py-3 px-4">
        <span className={clsx('shrink-0', executorColor)}>
          {isThinking ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Check size={14} />
          )}
        </span>
        <div className="flex-1 min-w-0">
          {message.executor && (
            <span className={clsx('text-xs font-medium mr-2', executorColor)}>
              [{message.executor}]
            </span>
          )}
          <pre className={clsx(
            'whitespace-pre-wrap font-mono text-sm inline',
            isThinking ? 'text-slate-400' : 'text-slate-300'
          )}>
            {message.content || (isThinking ? 'Processing...' : '')}
          </pre>
        </div>
        <span className="text-slate-600 text-xs font-mono opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          {formatTime(message.timestamp)}
        </span>
      </div>
    </div>
  );
}

// Tool call message
function ToolMessage({ message }: { message: TerminalMessageData }) {
  const [expanded, setExpanded] = useState(false);
  const toolName = message.toolName || 'tool';
  const Icon = getToolIcon(toolName);
  const isError = message.isError;
  const hasOutput = message.toolOutput || message.content;

  // Create preview from input
  const inputPreview = message.toolInput
    ? Object.entries(message.toolInput)
        .slice(0, 2)
        .map(([k, v]) => {
          const val = typeof v === 'string' ? v : JSON.stringify(v);
          return `${k}=${val.length > 40 ? val.slice(0, 40) + '...' : val}`;
        })
        .join(' ')
    : '';

  return (
    <div className="group">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-start gap-3 py-2 px-4 hover:bg-slate-800/50 transition-colors text-left"
      >
        <span className={clsx(
          'shrink-0 mt-0.5',
          isError ? 'text-red-400' : 'text-amber-400'
        )}>
          <Icon size={14} />
        </span>
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span className={clsx(
            'text-xs font-medium',
            isError ? 'text-red-400' : 'text-amber-400'
          )}>
            {toolName}
          </span>
          <span className="text-slate-500 text-xs font-mono truncate">
            {inputPreview}
          </span>
          {hasOutput && (
            <span className="shrink-0">
              {expanded ? (
                <ChevronDown size={12} className="text-slate-500" />
              ) : (
                <ChevronRight size={12} className="text-slate-500" />
              )}
            </span>
          )}
        </div>
        {isError ? (
          <X size={12} className="text-red-400 shrink-0" />
        ) : (
          <Check size={12} className="text-green-400 shrink-0" />
        )}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="ml-7 mr-4 mb-2">
          {message.toolInput && (
            <div className="mb-2">
              <div className="text-xs text-slate-500 mb-1">Input:</div>
              <pre className="bg-slate-800 rounded p-2 text-xs font-mono text-slate-400 overflow-x-auto max-h-32 overflow-y-auto">
                {JSON.stringify(message.toolInput, null, 2)}
              </pre>
            </div>
          )}
          {hasOutput && (
            <div>
              <div className="text-xs text-slate-500 mb-1">Output:</div>
              <pre className={clsx(
                'rounded p-2 text-xs font-mono overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap',
                isError ? 'bg-red-900/30 text-red-300' : 'bg-slate-800 text-slate-400'
              )}>
                {message.toolOutput || message.content}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// System/status message
function SystemMessage({ message }: { message: TerminalMessageData }) {
  const isError = message.type === 'error' || message.isError;
  const icon = message.content.includes('Starting') || message.content.includes('Executing')
    ? <Loader2 size={12} className="animate-spin" />
    : message.content.includes('Complete') || message.content.includes('Success')
    ? <Check size={12} />
    : message.content.includes('Failed') || isError
    ? <X size={12} />
    : <Zap size={12} />;

  return (
    <div className="flex items-center gap-2 py-1.5 px-4">
      <div className="flex-1 h-px bg-slate-800" />
      <span className={clsx(
        'flex items-center gap-1.5 text-xs',
        isError ? 'text-red-400' : 'text-slate-500'
      )}>
        {icon}
        {message.content}
      </span>
      <div className="flex-1 h-px bg-slate-800" />
    </div>
  );
}

// Result/completion message
function ResultMessage({ message }: { message: TerminalMessageData }) {
  const isError = message.isError || message.status === 'error';

  return (
    <div className={clsx(
      'mx-4 my-2 p-3 rounded border',
      isError
        ? 'bg-red-900/20 border-red-800 text-red-300'
        : 'bg-green-900/20 border-green-800 text-green-300'
    )}>
      <div className="flex items-center gap-2 mb-1">
        {isError ? (
          <X size={14} className="text-red-400" />
        ) : (
          <Check size={14} className="text-green-400" />
        )}
        <span className="text-xs font-medium">
          {isError ? 'Failed' : 'Completed'}
        </span>
      </div>
      <pre className="text-sm font-mono whitespace-pre-wrap">
        {message.content}
      </pre>
    </div>
  );
}

// Main message router
export function TerminalMessage({ message }: { message: TerminalMessageData }) {
  switch (message.type) {
    case 'user':
      return <UserMessage message={message} />;
    case 'assistant':
    case 'thinking':
      return <AssistantMessage message={message} />;
    case 'tool':
      return <ToolMessage message={message} />;
    case 'result':
      return <ResultMessage message={message} />;
    case 'system':
    case 'error':
      return <SystemMessage message={message} />;
    default:
      return <AssistantMessage message={message} />;
  }
}

export default TerminalMessage;
