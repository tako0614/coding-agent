import { useState } from 'react';
import clsx from 'clsx';
import {
  User,
  Bot,
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
  // Agent messages (simplified)
  status?: 'success' | 'error' | 'pending';
  metadata?: Record<string, unknown>;
}

interface MessageProps {
  message: ChatMessageData;
  compact?: boolean;
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

  // Determine colors and name based on executor: claude=purple, codex=green, supervisor/undefined=slate
  const getStyle = () => {
    if (message.executor === 'codex') {
      return {
        color: 'text-green-600',
        bg: 'bg-green-100',
        name: 'Codex',
      };
    } else if (message.executor === 'claude') {
      return {
        color: 'text-purple-600',
        bg: 'bg-purple-100',
        name: 'Claude',
      };
    } else {
      // Supervisor or unknown - use neutral slate colors
      return {
        color: 'text-slate-600',
        bg: 'bg-slate-200',
        name: 'Supervisor',
      };
    }
  };

  const style = getStyle();

  return (
    <div className="flex gap-3 px-4 py-4 bg-slate-50">
      <div className={clsx('w-8 h-8 rounded-full flex items-center justify-center shrink-0', style.bg)}>
        {isThinking ? (
          <Brain size={16} className={style.color} />
        ) : (
          <Bot size={16} className={style.color} />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs text-slate-400">{style.name}</span>
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
  const toolName = message.toolName || 'Tool';
  const inputStr = message.toolInput
    ? JSON.stringify(message.toolInput, null, 2)
    : '';
  const hasLongInput = inputStr.length > 300;
  const [inputCollapsed, setInputCollapsed] = useState(hasLongInput);

  return (
    <div className="px-4 py-2 ml-11">
      <div className="border border-amber-200 bg-amber-50 rounded-lg overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2">
          <ToolIcon name={toolName} className="w-4 h-4 text-amber-600" />
          <span className="font-medium text-sm text-amber-800">{toolName}</span>
        </div>
        {/* Show message content */}
        {message.content && (
          <div className="px-3 pb-2">
            <div className="text-sm text-slate-700 whitespace-pre-wrap">{message.content}</div>
          </div>
        )}
        {/* Show tool input if available */}
        {inputStr && (
          <div className="px-3 pb-3 border-t border-amber-200">
            <pre className="mt-2 bg-white rounded p-2 text-xs font-mono text-slate-700 overflow-x-auto whitespace-pre-wrap">
              {inputCollapsed ? inputStr.slice(0, 300) + '...' : inputStr}
            </pre>
            {hasLongInput && (
              <button
                onClick={() => setInputCollapsed(!inputCollapsed)}
                className="mt-2 text-xs text-amber-600 hover:text-amber-800"
              >
                {inputCollapsed ? '▼ 全文を表示' : '▲ 折りたたむ'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Tool Result Message Component
export function ToolResultMessage({ message }: { message: ChatMessageData }) {
  const isError = message.isError;
  const content = message.content || message.toolOutput || '';

  // Show full content by default, collapsible only for very long content (>500 chars)
  const isLongContent = content.length > 500;
  const [collapsed, setCollapsed] = useState(isLongContent);

  return (
    <div className="px-4 py-2 ml-11">
      <div className={clsx(
        'border rounded-lg overflow-hidden',
        isError ? 'border-red-200 bg-red-50' : 'border-green-200 bg-green-50'
      )}>
        <div className="flex items-center gap-2 px-3 py-2">
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
        </div>
        <div className={clsx(
          'px-3 pb-3 border-t',
          isError ? 'border-red-200' : 'border-green-200'
        )}>
          <pre className="mt-2 bg-white rounded p-2 text-xs font-mono text-slate-700 overflow-x-auto whitespace-pre-wrap">
            {collapsed ? content.slice(0, 500) + '...' : content}
          </pre>
          {isLongContent && (
            <button
              onClick={() => setCollapsed(!collapsed)}
              className={clsx(
                'mt-2 text-xs',
                isError ? 'text-red-600 hover:text-red-800' : 'text-green-600 hover:text-green-800'
              )}
            >
              {collapsed ? '▼ 全文を表示' : '▲ 折りたたむ'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Final Result Message Component
export function ResultMessage({ message }: { message: ChatMessageData }) {
  // Determine colors based on executor: claude=purple, codex=green, supervisor/undefined=slate
  const getColors = () => {
    if (message.executor === 'codex') {
      return {
        iconColor: 'text-green-600',
        iconBg: 'bg-green-100',
        contentBg: 'bg-green-50',
        border: 'border-green-200',
      };
    } else if (message.executor === 'claude') {
      return {
        iconColor: 'text-purple-600',
        iconBg: 'bg-purple-100',
        contentBg: 'bg-purple-50',
        border: 'border-purple-200',
      };
    } else {
      // Supervisor or unknown - use neutral slate colors
      return {
        iconColor: 'text-slate-600',
        iconBg: 'bg-slate-100',
        contentBg: 'bg-slate-50',
        border: 'border-slate-200',
      };
    }
  };

  const colors = getColors();

  return (
    <div className="flex gap-3 px-4 py-4">
      <div className={clsx('w-8 h-8 rounded-full flex items-center justify-center shrink-0', colors.iconBg)}>
        <CheckCircle size={16} className={colors.iconColor} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-slate-400 mb-2">Task Completed</div>
        <div className={clsx('rounded-lg border p-3', colors.contentBg, colors.border)}>
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

// Compact Agent Message (for multi-column view)
function CompactMessage({ message }: MessageProps) {
  const isUser = message.type === 'user';
  const isError = message.status === 'error' || message.isError;

  // Get icon color based on executor: claude=purple, codex=green, supervisor/undefined=slate
  const getIconColor = () => {
    if (message.executor === 'codex') return 'text-green-500';
    if (message.executor === 'claude') return 'text-purple-500';
    return 'text-slate-500'; // Supervisor or unknown
  };

  return (
    <div className={clsx(
      'px-2 py-1.5 text-xs rounded',
      isUser ? 'bg-blue-50 text-blue-800' : isError ? 'bg-red-50 text-red-700' : 'bg-slate-50 text-slate-700'
    )}>
      <div className="flex items-start gap-1.5">
        {isUser ? (
          <User size={12} className="text-blue-500 shrink-0 mt-0.5" />
        ) : (
          <Bot size={12} className={clsx(getIconColor(), 'shrink-0 mt-0.5')} />
        )}
        <span className="break-words">{message.content}</span>
      </div>
    </div>
  );
}

// Main ChatMessage router
export function ChatMessage({ message, compact }: MessageProps) {
  // Use compact mode for agent columns (multi-panel view)
  if (compact) {
    return <CompactMessage message={message} />;
  }

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
      // Fallback to assistant message for unknown types
      return <AssistantMessage message={message} />;
  }
}
