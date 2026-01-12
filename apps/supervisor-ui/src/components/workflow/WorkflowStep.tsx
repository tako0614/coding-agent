import { Check, Loader2, Circle, AlertCircle } from 'lucide-react';
import clsx from 'clsx';

export type StepStatus = 'pending' | 'active' | 'completed' | 'failed';

export interface WorkflowStepProps {
  name: string;
  description?: string;
  status: StepStatus;
  isLast?: boolean;
}

export function WorkflowStep({ name, description, status, isLast = false }: WorkflowStepProps) {
  const getIcon = () => {
    switch (status) {
      case 'completed':
        return <Check size={14} className="text-white" />;
      case 'active':
        return <Loader2 size={14} className="text-white animate-spin" />;
      case 'failed':
        return <AlertCircle size={14} className="text-white" />;
      default:
        return <Circle size={14} className="text-slate-400" />;
    }
  };

  const getCircleStyles = () => {
    switch (status) {
      case 'completed':
        return 'bg-emerald-500';
      case 'active':
        return 'bg-blue-500 ring-4 ring-blue-100';
      case 'failed':
        return 'bg-red-500';
      default:
        return 'bg-slate-200';
    }
  };

  return (
    <div className="flex items-start gap-3">
      {/* Icon and Line */}
      <div className="flex flex-col items-center">
        <div className={clsx(
          'w-6 h-6 rounded-full flex items-center justify-center transition-all',
          getCircleStyles()
        )}>
          {getIcon()}
        </div>
        {!isLast && (
          <div className={clsx(
            'w-0.5 h-8 mt-1',
            status === 'completed' ? 'bg-emerald-300' : 'bg-slate-200'
          )} />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 pb-6">
        <div className={clsx(
          'font-medium text-sm',
          status === 'active' ? 'text-blue-600' :
          status === 'completed' ? 'text-slate-700' :
          status === 'failed' ? 'text-red-600' :
          'text-slate-400'
        )}>
          {name}
        </div>
        {description && (
          <div className="text-xs text-slate-500 mt-0.5">
            {description}
          </div>
        )}
      </div>
    </div>
  );
}
