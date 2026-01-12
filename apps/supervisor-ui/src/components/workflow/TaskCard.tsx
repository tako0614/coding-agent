import { Check, Loader2, Clock, AlertCircle, Zap } from 'lucide-react';
import clsx from 'clsx';

export type TaskStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed';
export type ExecutorType = 'codex' | 'claude' | 'any';

export interface TaskCardProps {
  id: string;
  name: string;
  description?: string;
  status: TaskStatus;
  executor?: ExecutorType;
  dependencies?: string[];
  compact?: boolean;
}

export function TaskCard({
  name,
  description,
  status,
  executor,
  compact = false,
}: TaskCardProps) {
  const getStatusIcon = () => {
    switch (status) {
      case 'completed':
        return <Check size={14} className="text-emerald-500" />;
      case 'running':
        return <Loader2 size={14} className="text-blue-500 animate-spin" />;
      case 'failed':
        return <AlertCircle size={14} className="text-red-500" />;
      case 'ready':
        return <Zap size={14} className="text-amber-500" />;
      default:
        return <Clock size={14} className="text-slate-400" />;
    }
  };

  const getStatusStyles = () => {
    switch (status) {
      case 'completed':
        return 'border-emerald-200 bg-emerald-50/50';
      case 'running':
        return 'border-blue-300 bg-blue-50/50 ring-2 ring-blue-100';
      case 'failed':
        return 'border-red-200 bg-red-50/50';
      case 'ready':
        return 'border-amber-200 bg-amber-50/50';
      default:
        return 'border-slate-200 bg-slate-50/50';
    }
  };

  const getExecutorBadge = () => {
    if (!executor || executor === 'any') return null;

    return (
      <span className={clsx(
        'text-[10px] font-medium px-1.5 py-0.5 rounded',
        executor === 'codex' ? 'bg-green-100 text-green-700' : 'bg-purple-100 text-purple-700'
      )}>
        {executor === 'codex' ? 'Codex' : 'Claude'}
      </span>
    );
  };

  if (compact) {
    return (
      <div className={clsx(
        'flex items-center gap-2 px-2 py-1.5 rounded-lg border transition-all',
        getStatusStyles()
      )}>
        {getStatusIcon()}
        <span className="text-xs text-slate-700 truncate flex-1">{name}</span>
        {getExecutorBadge()}
      </div>
    );
  }

  return (
    <div className={clsx(
      'p-3 rounded-xl border transition-all',
      getStatusStyles()
    )}>
      <div className="flex items-start gap-2">
        <div className="mt-0.5">
          {getStatusIcon()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-slate-700 truncate">
              {name}
            </span>
            {getExecutorBadge()}
          </div>
          {description && (
            <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">
              {description}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
