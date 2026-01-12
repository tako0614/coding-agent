import { useRef, useEffect } from 'react';
import {
  FileText,
  FolderOpen,
  Terminal,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Info,
  Zap,
} from 'lucide-react';
import clsx from 'clsx';

export interface ActivityEntry {
  id: string;
  timestamp: string;
  type: 'info' | 'success' | 'error' | 'warning' | 'task' | 'file' | 'command';
  message: string;
  source?: 'supervisor' | 'codex' | 'claude' | 'system';
  metadata?: Record<string, unknown>;
}

interface ActivityLogProps {
  entries: ActivityEntry[];
  autoScroll?: boolean;
  maxHeight?: string;
}

function getIcon(type: ActivityEntry['type'], source?: ActivityEntry['source']) {
  if (source === 'codex') {
    return <Zap size={12} className="text-green-500" />;
  }
  if (source === 'claude') {
    return <Zap size={12} className="text-purple-500" />;
  }

  switch (type) {
    case 'success':
      return <CheckCircle size={12} className="text-emerald-500" />;
    case 'error':
      return <XCircle size={12} className="text-red-500" />;
    case 'warning':
      return <AlertTriangle size={12} className="text-amber-500" />;
    case 'file':
      return <FileText size={12} className="text-blue-500" />;
    case 'command':
      return <Terminal size={12} className="text-slate-500" />;
    case 'task':
      return <FolderOpen size={12} className="text-indigo-500" />;
    default:
      return <Info size={12} className="text-slate-400" />;
  }
}

function formatTime(timestamp: string) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function parseMessage(message: string) {
  // Highlight file paths
  const filePathRegex = /([\w\/\-\.]+\.(ts|tsx|js|jsx|py|md|json|yaml|yml|css|html))/g;

  // Highlight task names
  const taskRegex = /(✓|✗|▶|🔧|🚀|🎯|📋|🔍)/g;

  return message
    .replace(filePathRegex, '<span class="text-blue-600 font-mono text-xs">$1</span>')
    .replace(taskRegex, '<span class="mr-1">$1</span>');
}

export function ActivityLog({ entries, autoScroll = true, maxHeight = '400px' }: ActivityLogProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && endRef.current) {
      endRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [entries.length, autoScroll]);

  if (entries.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-3">Activity</h3>
        <div className="text-center py-8 text-slate-400 text-sm">
          No activity yet
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100">
        <h3 className="text-sm font-semibold text-slate-700">Activity</h3>
      </div>

      <div
        className="overflow-y-auto"
        style={{ maxHeight }}
      >
        <div className="divide-y divide-slate-50">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className={clsx(
                'px-4 py-2 hover:bg-slate-50 transition-colors',
                entry.type === 'error' && 'bg-red-50/50',
                entry.type === 'warning' && 'bg-amber-50/50'
              )}
            >
              <div className="flex items-start gap-2">
                <div className="mt-0.5 flex-shrink-0">
                  {getIcon(entry.type, entry.source)}
                </div>
                <div className="flex-1 min-w-0">
                  <div
                    className="text-sm text-slate-700 break-words"
                    dangerouslySetInnerHTML={{ __html: parseMessage(entry.message) }}
                  />
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-slate-400">
                      {formatTime(entry.timestamp)}
                    </span>
                    {entry.source && entry.source !== 'system' && (
                      <span className={clsx(
                        'text-[10px] px-1 rounded',
                        entry.source === 'codex' && 'bg-green-100 text-green-700',
                        entry.source === 'claude' && 'bg-purple-100 text-purple-700',
                        entry.source === 'supervisor' && 'bg-blue-100 text-blue-700'
                      )}>
                        {entry.source}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
        <div ref={endRef} />
      </div>
    </div>
  );
}
