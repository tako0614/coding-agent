import { useState } from 'react';
import clsx from 'clsx';
import {
  User,
  Bot,
  ChevronDown,
  ChevronRight,
  Terminal,
  Eye,
  Pencil,
  Search,
  Zap,
  CheckCircle,
  XCircle,
  Loader2,
  Brain,
  Cpu,
} from 'lucide-react';

// Message types
export type MessageType =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'result'
  | 'system';

export interface ChatMessageData {
  id: string;
  type: MessageType;
  content: string;
  timestamp: string;
  // For tool messages
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  isError?: boolean;
  // For assistant messages
  isThinking?: boolean;
  // Executor info
  executor?: 'claude' | 'codex';
}

// Tool icon helper
function ToolIcon({ name, className }: { name: string; className?: string }) {
  const iconClass = className || "w-4 h-4";
  const lowerName = name.toLowerCase();

  if (lowerName.includes('read') || lowerName.includes('glob') || lowerName.includes('grep')) {
    return <Eye className={iconClass} />;
  }
  if (lowerName.includes('write') || lowerName.includes('edit')) {
    return <Pencil className={iconClass} />;
  }
  if (lowerName.includes('bash') || lowerName.includes('shell')) {
    return <Terminal className={iconClass} />;
  }
  if (lowerName.includes('search')) {
    return <Search className={iconClass} />;
  }
  return <Zap className={iconClass} />;
}

// User Message Component
export function UserMessage({ message }: { message: ChatMessageData }) {
  return (
    <div className="flex gap-3 px-4 py-4">
      <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
        <User size={16} className="text-blue-600" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-slate-400 mb-1">You</div>
        <div className="text-slate-800 whitespace-pre-wrap">{message.content}</div>
      </div>
    </div>
  );
}

// Assistant Message Component
export function AssistantMessage({ message }: { message: ChatMessageData }) {
  const isThinking = message.isThinking || message.type === 'thinking';
  const executorColor = message.executor === 'codex' ? 'text-green-600' : 'text-purple-600';
  const executorBg = message.executor === 'codex' ? 'bg-green-100' : 'bg-purple-100';
  const executorName = message.executor === 'codex' ? 'Codex' : 'Claude';

  return (
    <div className="flex gap-3 px-4 py-4 bg-slate-50">
      <div className={clsx('w-8 h-8 rounded-full flex items-center justify-center shrink-0', executorBg)}>
        {isThinking ? (
          <Brain size={16} className={executorColor} />
        ) : (
          <Bot size={16} className={executorColor} />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs text-slate-400">{executorName}</span>
          {isThinking && (
            <span className="text-xs text-slate-400 flex items-center gap-1">
              <Loader2 size={10} className="animate-spin" />
              Thinking...
            </span>
          )}
        </div>
        <div className={clsx(
          'whitespace-pre-wrap',
          isThinking ? 'text-slate-500 italic' : 'text-slate-800'
        )}>
          {message.content || (isThinking ? 'Processing...' : '')}
        </div>
      </div>
    </div>
  );
}

// Tool Use Message Component
export function ToolUseMessage({ message }: { message: ChatMessageData }) {
  const [expanded, setExpanded] = useState(false);
  const toolName = message.toolName || 'Unknown Tool';
  const inputStr = message.toolInput
    ? JSON.stringify(message.toolInput, null, 2)
    : '';

  // Get a preview of the input
  const preview = message.toolInput
    ? Object.entries(message.toolInput)
        .slice(0, 2)
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v.slice(0, 30) : JSON.stringify(v).slice(0, 30)}`)
        .join(', ')
    : '';

  return (
    <div className="px-4 py-2 ml-11">
      <div className="border border-amber-200 bg-amber-50 rounded-lg overflow-hidden">
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-2 px-3 py-2 hover:bg-amber-100 transition-colors"
        >
          <ToolIcon name={toolName} className="w-4 h-4 text-amber-600" />
          <span className="font-medium text-sm text-amber-800">{toolName}</span>
          <span className="text-xs text-amber-600 truncate flex-1 text-left font-mono">
            {preview && preview.length > 50 ? preview.slice(0, 50) + '...' : preview}
          </span>
          {expanded ? (
            <ChevronDown size={14} className="text-amber-600" />
          ) : (
            <ChevronRight size={14} className="text-amber-600" />
          )}
        </button>
        {expanded && inputStr && (
          <div className="px-3 pb-3 border-t border-amber-200">
            <pre className="mt-2 bg-white rounded p-2 text-xs font-mono text-slate-700 overflow-x-auto max-h-48 overflow-y-auto">
              {inputStr}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

// Tool Result Message Component
export function ToolResultMessage({ message }: { message: ChatMessageData }) {
  const [expanded, setExpanded] = useState(false);
  const isError = message.isError;
  const content = message.content || message.toolOutput || '';

  // Preview
  const preview = content.length > 80 ? content.slice(0, 80) + '...' : content;

  return (
    <div className="px-4 py-2 ml-11">
      <div className={clsx(
        'border rounded-lg overflow-hidden',
        isError ? 'border-red-200 bg-red-50' : 'border-green-200 bg-green-50'
      )}>
        <button
          onClick={() => setExpanded(!expanded)}
          className={clsx(
            'w-full flex items-center gap-2 px-3 py-2 transition-colors',
            isError ? 'hover:bg-red-100' : 'hover:bg-green-100'
          )}
        >
          {isError ? (
            <XCircle size={14} className="text-red-500 shrink-0" />
          ) : (
            <CheckCircle size={14} className="text-green-500 shrink-0" />
          )}
          <span className={clsx(
            'font-medium text-sm',
            isError ? 'text-red-700' : 'text-green-700'
          )}>
            {isError ? 'Error' : 'Result'}
          </span>
          <span className="text-xs text-slate-600 truncate flex-1 text-left">
            {preview}
          </span>
          {content.length > 80 && (
            expanded ? (
              <ChevronDown size={14} className="text-slate-400" />
            ) : (
              <ChevronRight size={14} className="text-slate-400" />
            )
          )}
        </button>
        {expanded && (
          <div className={clsx(
            'px-3 pb-3 border-t',
            isError ? 'border-red-200' : 'border-green-200'
          )}>
            <pre className="mt-2 bg-white rounded p-2 text-xs font-mono text-slate-700 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap">
              {content}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

// Final Result Message Component
export function ResultMessage({ message }: { message: ChatMessageData }) {
  const executorColor = message.executor === 'codex' ? 'text-green-600' : 'text-purple-600';
  const executorBg = message.executor === 'codex' ? 'bg-green-50' : 'bg-purple-50';
  const borderColor = message.executor === 'codex' ? 'border-green-200' : 'border-purple-200';

  return (
    <div className="flex gap-3 px-4 py-4">
      <div className={clsx('w-8 h-8 rounded-full flex items-center justify-center shrink-0',
        message.executor === 'codex' ? 'bg-green-100' : 'bg-purple-100'
      )}>
        <CheckCircle size={16} className={executorColor} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-slate-400 mb-2">Task Completed</div>
        <div className={clsx('rounded-lg border p-3', executorBg, borderColor)}>
          <div className="text-slate-800 whitespace-pre-wrap">{message.content}</div>
        </div>
      </div>
    </div>
  );
}

// System Message Component (for status updates)
export function SystemMessage({ message }: { message: ChatMessageData }) {
  // Check if message contains executor indicator
  const isCodex = message.content.includes('Codex') || message.content.includes('🟢');
  const isClaude = message.content.includes('Claude') || message.content.includes('🟣');

  return (
    <div className="px-4 py-2">
      <div className={clsx(
        'flex items-center justify-center gap-2 text-xs',
        isCodex ? 'text-green-600' : isClaude ? 'text-purple-600' : 'text-slate-400'
      )}>
        <div className={clsx(
          'h-px flex-1',
          isCodex ? 'bg-green-200' : isClaude ? 'bg-purple-200' : 'bg-slate-200'
        )} />
        <Cpu size={12} />
        <span>{message.content}</span>
        <div className={clsx(
          'h-px flex-1',
          isCodex ? 'bg-green-200' : isClaude ? 'bg-purple-200' : 'bg-slate-200'
        )} />
      </div>
    </div>
  );
}

// Main ChatMessage router
export function ChatMessage({ message }: { message: ChatMessageData }) {
  switch (message.type) {
    case 'user':
      return <UserMessage message={message} />;
    case 'assistant':
    case 'thinking':
      return <AssistantMessage message={message} />;
    case 'tool_use':
      return <ToolUseMessage message={message} />;
    case 'tool_result':
      return <ToolResultMessage message={message} />;
    case 'result':
      return <ResultMessage message={message} />;
    case 'system':
      return <SystemMessage message={message} />;
    default:
      return null;
  }
}
