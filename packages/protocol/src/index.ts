/**
 * @supervisor/protocol
 * WorkOrder/WorkReport protocol definitions for Supervisor Agent
 */

// Types
export type {
  WorkOrder,
  TaskKind,
  DependencyPolicy,
  NetworkPolicy,
  RepoInfo,
  Constraints,
  VerificationCommand,
  Verification,
  Tooling,
  RateLimit,
  WorkOrderMetadata,
} from './types/work-order.js';

export type {
  WorkReport,
  ExecutorType,
  WorkStatus,
  FileChanges,
  CommandResult,
  VerificationResult,
  Question,
  WorkError,
  TokenUsage,
  WorkReportMetadata,
} from './types/work-report.js';

export type {
  RunState,
  RunStatus,
  ModelPolicy,
  SecurityPolicy,
  IterationCounters,
  VerificationResults,
  Artifact,
} from './types/run.js';

export type {
  DAGNode,
  DAGNodeStatus,
  DAGEdge,
  DAG,
  DAGProgress,
  ExecutorPreference,
} from './types/dag.js';

export type {
  Worker,
  WorkerStatus,
  WorkerExecutorType,
  WorkerPoolConfig,
  WorkerPoolStatus,
  WorkerTaskAssignment,
} from './types/worker.js';

// Type guards
export {
  isTaskKind,
  isWorkOrderId,
  isRunId,
} from './types/work-order.js';

export {
  isExecutorType,
  isWorkStatus,
  isWorkReportId,
} from './types/work-report.js';

// Factory functions
export {
  createRunId,
  createWorkOrderId,
  createWorkReportId,
  createInitialRunState,
} from './types/run.js';

export {
  createTaskId,
  createDAGId,
  isTaskId,
  isDAGId,
} from './types/dag.js';

export {
  createWorkerId,
  isWorkerId,
  isWorkerExecutorType,
  isWorkerStatus,
  DEFAULT_WORKER_POOL_CONFIG,
} from './types/worker.js';

// Validation
export {
  validateWorkOrder,
  validateWorkReport,
  assertWorkOrder,
  assertWorkReport,
  workOrderSchema,
  workReportSchema,
  type ValidationResult,
} from './validator.js';
