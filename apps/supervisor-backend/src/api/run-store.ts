/**
 * Run store with SQLite persistence
 * Uses in-memory for running state, persists completed runs to database
 */

import type { SupervisorStateType } from '../graph/state.js';
import type { ParallelSupervisorStateType } from '../graph/parallel-state.js';
import type { RunResponse, DAGResponse, WorkerPoolResponse } from './types.js';
import { db } from '../services/db.js';

// Prepared statements for runs table
const insertRunStmt = db.prepare(`
  INSERT OR REPLACE INTO runs (
    run_id, project_id, status, user_goal, repo_path,
    final_report, error, dag_json, dag_progress_json,
    created_at, updated_at
  ) VALUES (
    @run_id, @project_id, @status, @user_goal, @repo_path,
    @final_report, @error, @dag_json, @dag_progress_json,
    @created_at, @updated_at
  )
`);

const getRunStmt = db.prepare(`
  SELECT * FROM runs WHERE run_id = ?
`);

const listRunsStmt = db.prepare(`
  SELECT * FROM runs ORDER BY created_at DESC LIMIT 100
`);

const listRunsByProjectStmt = db.prepare(`
  SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 100
`);

const deleteRunStmt = db.prepare(`
  DELETE FROM runs WHERE run_id = ?
`);

const updateRunStatusStmt = db.prepare(`
  UPDATE runs SET status = @status, updated_at = @updated_at,
    final_report = @final_report, error = @error,
    dag_json = @dag_json, dag_progress_json = @dag_progress_json
  WHERE run_id = @run_id
`);

interface RunRow {
  run_id: string;
  project_id: string | null;
  status: string;
  user_goal: string;
  repo_path: string;
  final_report: string | null;
  error: string | null;
  dag_json: string | null;
  dag_progress_json: string | null;
  created_at: string;
  updated_at: string;
}

class RunStore {
  private runs: Map<string, SupervisorStateType> = new Map();
  private runningPromises: Map<string, Promise<SupervisorStateType>> = new Map();

  /**
   * Store a run state
   */
  set(runId: string, state: SupervisorStateType): void {
    this.runs.set(runId, state);
  }

  /**
   * Get a run state
   */
  get(runId: string): SupervisorStateType | undefined {
    return this.runs.get(runId);
  }

  /**
   * Check if a run exists
   */
  has(runId: string): boolean {
    return this.runs.has(runId);
  }

  /**
   * Delete a run
   */
  delete(runId: string): boolean {
    this.runningPromises.delete(runId);
    return this.runs.delete(runId);
  }

  /**
   * List all runs
   */
  list(): RunResponse[] {
    return Array.from(this.runs.values()).map(state => this.toResponse(state));
  }

  /**
   * Track a running promise
   */
  setRunning(runId: string, promise: Promise<SupervisorStateType>): void {
    this.runningPromises.set(runId, promise);
  }

  /**
   * Check if a run is currently executing
   */
  isRunning(runId: string): boolean {
    return this.runningPromises.has(runId);
  }

  /**
   * Wait for a run to complete
   */
  async waitFor(runId: string): Promise<SupervisorStateType | undefined> {
    const promise = this.runningPromises.get(runId);
    if (promise) {
      return promise;
    }
    return this.runs.get(runId);
  }

  /**
   * Convert state to response format
   */
  toResponse(state: SupervisorStateType): RunResponse {
    return {
      run_id: state.run_id,
      status: state.status,
      user_goal: state.user_goal,
      created_at: state.created_at,
      updated_at: state.updated_at,
      verification_passed: state.verification_results?.all_passed,
      error: state.error,
      final_report: state.final_report,
    };
  }

  /**
   * Clear all runs
   */
  clear(): void {
    this.runs.clear();
    this.runningPromises.clear();
  }
}

// Singleton instance
export const runStore = new RunStore();

/**
 * Helper to convert DB row to RunResponse
 */
function rowToRunResponse(row: RunRow): RunResponse {
  return {
    run_id: row.run_id,
    status: row.status as RunResponse['status'],
    user_goal: row.user_goal,
    created_at: row.created_at,
    updated_at: row.updated_at,
    verification_passed: row.status === 'completed',
    error: row.error ?? undefined,
    final_report: row.final_report ?? undefined,
  };
}

/**
 * Parallel run store for DAG-based parallel execution
 * Persists completed runs to SQLite database
 */
class ParallelRunStore {
  private runs: Map<string, ParallelSupervisorStateType> = new Map();
  private runningPromises: Map<string, Promise<ParallelSupervisorStateType>> = new Map();
  private runningGoals: Map<string, string> = new Map();
  private runningStartTimes: Map<string, string> = new Map();
  private runProjectIds: Map<string, string> = new Map();
  private runRepoPaths: Map<string, string> = new Map();

  /**
   * Store a run state (and persist to DB)
   */
  set(runId: string, state: ParallelSupervisorStateType): void {
    this.runs.set(runId, state);
    this.runningPromises.delete(runId);

    // Persist to database
    this.persistToDb(runId, state);

    this.runningGoals.delete(runId);
    this.runningStartTimes.delete(runId);
  }

  /**
   * Persist run state to database
   */
  private persistToDb(runId: string, state: ParallelSupervisorStateType): void {
    try {
      insertRunStmt.run({
        run_id: state.run_id,
        project_id: state.project_id || this.runProjectIds.get(runId) || null,
        status: state.status,
        user_goal: state.user_goal,
        repo_path: state.repo_path || this.runRepoPaths.get(runId) || '',
        final_report: state.final_report || null,
        error: state.error || null,
        dag_json: state.dag ? JSON.stringify(state.dag) : null,
        dag_progress_json: state.dag_progress ? JSON.stringify(state.dag_progress) : null,
        created_at: state.created_at,
        updated_at: state.updated_at,
      });
    } catch (err) {
      console.error('[ParallelRunStore] Failed to persist run to DB:', err);
    }
  }

  /**
   * Update run status in database
   */
  updateStatus(runId: string, state: ParallelSupervisorStateType): void {
    try {
      updateRunStatusStmt.run({
        run_id: runId,
        status: state.status,
        updated_at: state.updated_at,
        final_report: state.final_report || null,
        error: state.error || null,
        dag_json: state.dag ? JSON.stringify(state.dag) : null,
        dag_progress_json: state.dag_progress ? JSON.stringify(state.dag_progress) : null,
      });
    } catch (err) {
      console.error('[ParallelRunStore] Failed to update run status in DB:', err);
    }
  }

  /**
   * Get a run state (from memory or DB)
   */
  get(runId: string): ParallelSupervisorStateType | undefined {
    // Check in-memory first
    const memState = this.runs.get(runId);
    if (memState) return memState;

    // Try loading from DB
    try {
      const row = getRunStmt.get(runId) as RunRow | undefined;
      if (row) {
        // Reconstruct state from DB with required default values
        const state = {
          run_id: row.run_id,
          project_id: row.project_id || undefined,
          status: row.status as ParallelSupervisorStateType['status'],
          user_goal: row.user_goal,
          repo_path: row.repo_path,
          created_at: row.created_at,
          updated_at: row.updated_at,
          final_report: row.final_report || undefined,
          error: row.error || undefined,
          dag: row.dag_json ? JSON.parse(row.dag_json) : undefined,
          dag_progress: row.dag_progress_json ? JSON.parse(row.dag_progress_json) : undefined,
          // Required default values for type compatibility
          spec: undefined,
          worker_pool_status: undefined,
          reports: [],
          artifacts: [],
          messages: [],
          model_policy: { auto_downgrade: true },
          security_policy: { sandbox_enforced: true },
        } as unknown as ParallelSupervisorStateType;
        return state;
      }
    } catch (err) {
      console.error('[ParallelRunStore] Failed to load run from DB:', err);
    }
    return undefined;
  }

  /**
   * Check if a run exists
   */
  has(runId: string): boolean {
    if (this.runs.has(runId) || this.runningPromises.has(runId)) {
      return true;
    }
    // Check DB
    try {
      const row = getRunStmt.get(runId) as RunRow | undefined;
      return !!row;
    } catch {
      return false;
    }
  }

  /**
   * Delete a run (from memory and DB)
   */
  delete(runId: string): boolean {
    this.runningPromises.delete(runId);
    this.runProjectIds.delete(runId);
    this.runRepoPaths.delete(runId);
    const memDeleted = this.runs.delete(runId);

    // Delete from DB
    try {
      const result = deleteRunStmt.run(runId);
      return memDeleted || result.changes > 0;
    } catch (err) {
      console.error('[ParallelRunStore] Failed to delete run from DB:', err);
      return memDeleted;
    }
  }

  /**
   * List all runs (from memory and DB)
   */
  list(): RunResponse[] {
    // Get running runs from memory
    const runningIds = Array.from(this.runningPromises.keys());
    const running = runningIds.map(runId => ({
      run_id: runId,
      status: 'running' as const,
      user_goal: this.runningGoals.get(runId) ?? 'Unknown goal',
      created_at: this.runningStartTimes.get(runId) ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));

    // Get completed runs from DB
    try {
      const rows = listRunsStmt.all() as RunRow[];
      const fromDb = rows
        .filter(row => !runningIds.includes(row.run_id)) // Exclude running ones
        .map(rowToRunResponse);

      return [...running, ...fromDb];
    } catch (err) {
      console.error('[ParallelRunStore] Failed to list runs from DB:', err);
      // Fallback to in-memory only
      const completed = Array.from(this.runs.values()).map(state => this.toResponse(state));
      return [...running, ...completed];
    }
  }

  /**
   * List runs by project ID
   */
  listByProject(projectId: string): RunResponse[] {
    const runningIds = Array.from(this.runningPromises.keys());
    const running = runningIds
      .filter(runId => this.runProjectIds.get(runId) === projectId)
      .map(runId => ({
        run_id: runId,
        status: 'running' as const,
        user_goal: this.runningGoals.get(runId) ?? 'Unknown goal',
        created_at: this.runningStartTimes.get(runId) ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }));

    try {
      const rows = listRunsByProjectStmt.all(projectId) as RunRow[];
      const fromDb = rows
        .filter(row => !runningIds.includes(row.run_id))
        .map(rowToRunResponse);

      return [...running, ...fromDb];
    } catch (err) {
      console.error('[ParallelRunStore] Failed to list project runs from DB:', err);
      return running;
    }
  }

  /**
   * Track a running promise
   */
  setRunning(runId: string, promise: Promise<ParallelSupervisorStateType>, goal?: string, projectId?: string, repoPath?: string): void {
    this.runningPromises.set(runId, promise);
    if (goal) {
      this.runningGoals.set(runId, goal);
    }
    if (projectId) {
      this.runProjectIds.set(runId, projectId);
    }
    if (repoPath) {
      this.runRepoPaths.set(runId, repoPath);
    }
    this.runningStartTimes.set(runId, new Date().toISOString());

    // Insert initial run record to DB
    try {
      insertRunStmt.run({
        run_id: runId,
        project_id: projectId || null,
        status: 'running',
        user_goal: goal || 'Unknown goal',
        repo_path: repoPath || '',
        final_report: null,
        error: null,
        dag_json: null,
        dag_progress_json: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[ParallelRunStore] Failed to insert initial run to DB:', err);
    }
  }

  /**
   * Check if a run is currently executing
   */
  isRunning(runId: string): boolean {
    return this.runningPromises.has(runId);
  }

  /**
   * Wait for a run to complete
   */
  async waitFor(runId: string): Promise<ParallelSupervisorStateType | undefined> {
    const promise = this.runningPromises.get(runId);
    if (promise) {
      return promise;
    }
    return this.get(runId);
  }

  /**
   * Convert state to response format
   */
  toResponse(state: ParallelSupervisorStateType): RunResponse {
    return {
      run_id: state.run_id,
      status: state.status,
      user_goal: state.user_goal,
      created_at: state.created_at,
      updated_at: state.updated_at,
      verification_passed: state.dag_progress?.failed === 0,
      error: state.error,
      final_report: state.final_report,
    };
  }

  /**
   * Get DAG response
   */
  getDAG(runId: string): DAGResponse | null {
    const state = this.runs.get(runId);
    if (!state?.dag) return null;

    return {
      dag_id: state.dag.dag_id,
      run_id: state.dag.run_id,
      nodes: state.dag.nodes.map(node => ({
        task_id: node.task_id,
        name: node.name,
        description: node.description,
        dependencies: node.dependencies,
        executor_preference: node.executor_preference,
        priority: node.priority,
        status: node.status,
        assigned_worker_id: node.assigned_worker_id,
        started_at: node.started_at,
        completed_at: node.completed_at,
        error: node.error,
      })),
      edges: state.dag.edges,
      progress: state.dag_progress ?? {
        total: state.dag.nodes.length,
        completed: 0,
        failed: 0,
        running: 0,
        ready: 0,
        pending: state.dag.nodes.length,
        percentage: 0,
      },
      created_at: state.dag.created_at,
      updated_at: state.dag.updated_at,
    };
  }

  /**
   * Get Worker Pool response
   */
  getWorkerPool(runId: string): WorkerPoolResponse | null {
    const state = this.runs.get(runId);
    if (!state?.worker_pool_status) return null;

    return {
      total_workers: state.worker_pool_status.total_workers,
      idle_workers: state.worker_pool_status.idle_workers,
      busy_workers: state.worker_pool_status.busy_workers,
      error_workers: state.worker_pool_status.error_workers,
      workers: state.worker_pool_status.workers.map(worker => ({
        worker_id: worker.worker_id,
        executor_type: worker.executor_type,
        status: worker.status,
        current_task_id: worker.current_task_id,
        created_at: worker.created_at,
        completed_tasks: worker.completed_tasks,
        failed_tasks: worker.failed_tasks,
        avg_task_duration_ms: worker.avg_task_duration_ms,
      })),
      total_tasks_completed: state.worker_pool_status.total_tasks_completed,
      total_tasks_failed: state.worker_pool_status.total_tasks_failed,
    };
  }

  /**
   * Clear all runs
   */
  clear(): void {
    this.runs.clear();
    this.runningPromises.clear();
  }
}

// Singleton instance for parallel runs
export const parallelRunStore = new ParallelRunStore();
