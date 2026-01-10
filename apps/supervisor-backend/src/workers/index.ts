/**
 * Workers module
 * Parallel task execution infrastructure
 */

export {
  WorkerInstance,
  createWorkerInstance,
  type WorkerInstanceConfig,
  type TaskExecutionResult,
  type TaskContext,
} from './worker-instance.js';

export {
  WorkerPool,
  createWorkerPool,
  type WorkerPoolEvents,
  type PoolContext,
} from './worker-pool.js';

export {
  DAGScheduler,
  createDAGScheduler,
} from './dag-scheduler.js';
