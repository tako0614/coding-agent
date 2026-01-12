import { WorkflowStep, type StepStatus } from './WorkflowStep';

export type WorkflowState =
  | 'idle'
  | 'intake'
  | 'reading_context'
  | 'analyzing'
  | 'building_dag'
  | 'executing'
  | 'adjusting'
  | 'reviewing'
  | 'completed'
  | 'failed';

interface WorkflowPanelProps {
  state: WorkflowState;
  iteration?: number;
}

const WORKFLOW_STEPS = [
  { key: 'intake', name: 'Intake', description: 'Receiving goal' },
  { key: 'reading_context', name: 'Read Context', description: 'Loading AGENTS.md' },
  { key: 'analyzing', name: 'Analyze', description: 'Understanding current state' },
  { key: 'building_dag', name: 'Plan Tasks', description: 'Breaking down into tasks' },
  { key: 'executing', name: 'Execute', description: 'Running tasks in parallel' },
  { key: 'reviewing', name: 'Review', description: 'Checking results' },
] as const;

function getStepStatus(stepKey: string, currentState: WorkflowState): StepStatus {
  const stepOrder = WORKFLOW_STEPS.map(s => s.key);
  const currentIndex = stepOrder.indexOf(currentState as typeof stepOrder[number]);
  const stepIndex = stepOrder.indexOf(stepKey as typeof stepOrder[number]);

  if (currentState === 'completed') return 'completed';
  if (currentState === 'failed') {
    if (stepIndex < currentIndex) return 'completed';
    if (stepIndex === currentIndex) return 'failed';
    return 'pending';
  }
  if (currentState === 'idle') return 'pending';
  if (currentState === 'adjusting') {
    // Adjusting is between executing and reviewing
    if (stepKey === 'executing') return 'completed';
    if (stepKey === 'reviewing') return 'active';
    if (stepIndex < stepOrder.indexOf('executing')) return 'completed';
    return 'pending';
  }

  if (stepIndex < currentIndex) return 'completed';
  if (stepIndex === currentIndex) return 'active';
  return 'pending';
}

export function WorkflowPanel({ state, iteration = 0 }: WorkflowPanelProps) {
  const isIdle = state === 'idle';

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-slate-700">Workflow</h3>
        {iteration > 0 && (
          <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
            Iteration {iteration}
          </span>
        )}
      </div>

      {isIdle ? (
        <div className="text-center py-6 text-slate-400 text-sm">
          Waiting for task...
        </div>
      ) : (
        <div className="space-y-0">
          {WORKFLOW_STEPS.map((step, index) => (
            <WorkflowStep
              key={step.key}
              name={step.name}
              description={step.description}
              status={getStepStatus(step.key, state)}
              isLast={index === WORKFLOW_STEPS.length - 1}
            />
          ))}
        </div>
      )}

      {state === 'adjusting' && (
        <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded-lg">
          <div className="text-xs font-medium text-amber-700">
            Making adjustments...
          </div>
        </div>
      )}

      {state === 'completed' && (
        <div className="mt-2 p-2 bg-emerald-50 border border-emerald-200 rounded-lg">
          <div className="text-xs font-medium text-emerald-700">
            Task completed successfully
          </div>
        </div>
      )}

      {state === 'failed' && (
        <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded-lg">
          <div className="text-xs font-medium text-red-700">
            Task failed
          </div>
        </div>
      )}
    </div>
  );
}
