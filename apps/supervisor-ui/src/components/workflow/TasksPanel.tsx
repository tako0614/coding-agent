import { TaskCard, type TaskStatus, type ExecutorType } from './TaskCard';
import { Loader2 } from 'lucide-react';

export interface Task {
  task_id: string;
  name: string;
  description?: string;
  status: TaskStatus;
  executor_preference?: ExecutorType;
  dependencies?: string[];
}

interface TasksPanelProps {
  tasks: Task[];
  isLoading?: boolean;
  progress?: {
    total: number;
    completed: number;
    failed: number;
    running: number;
  };
}

export function TasksPanel({ tasks, isLoading, progress }: TasksPanelProps) {
  const isEmpty = tasks.length === 0;

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-700">Tasks</h3>
        {progress && progress.total > 0 && (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <div className="w-2 h-2 rounded-full bg-emerald-500" />
              <span className="text-xs text-slate-500">{progress.completed}</span>
            </div>
            {progress.running > 0 && (
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                <span className="text-xs text-slate-500">{progress.running}</span>
              </div>
            )}
            {progress.failed > 0 && (
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full bg-red-500" />
                <span className="text-xs text-slate-500">{progress.failed}</span>
              </div>
            )}
            <span className="text-xs text-slate-400">/ {progress.total}</span>
          </div>
        )}
      </div>

      {/* Progress Bar */}
      {progress && progress.total > 0 && (
        <div className="mb-3">
          <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-emerald-400 to-emerald-500 transition-all duration-500"
              style={{ width: `${(progress.completed / progress.total) * 100}%` }}
            />
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-8 text-slate-400">
          <Loader2 size={20} className="animate-spin" />
        </div>
      ) : isEmpty ? (
        <div className="text-center py-6 text-slate-400 text-sm">
          No tasks yet
        </div>
      ) : (
        <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
          {tasks.map((task) => (
            <TaskCard
              key={task.task_id}
              id={task.task_id}
              name={task.name}
              description={task.description}
              status={task.status}
              executor={task.executor_preference}
              dependencies={task.dependencies}
              compact
            />
          ))}
        </div>
      )}
    </div>
  );
}
