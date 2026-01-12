/**
 * Run store with SQLite persistence
 * Uses in-memory for running state, persists completed runs to database
 */

import type { SimplifiedSupervisorStateType } from '../graph/index.js';
import type { RunResponse, WorkerPoolResponse, RunMode } from './types.js';
import { db } from '../services/db.js';
import { logger } from '../services/logger.js';
import { DatabaseError, RunNotFoundError, getErrorMessage } from '../services/errors.js';

// Prepared statements for runs table
const insertRunStmt = db.prepare(`
  INSERT OR REPLACE INTO runs (
    run_id, project_id, user_goal, repo_path, mode,
    final_report, error, dag_json, dag_progress_json,
    created_at, updated_at
  ) VALUES (
    @run_id, @project_id, @user_goal, @repo_path, @mode,
    @final_report, @error, @dag_json, @dag_progress_json,
    @created_at, @updated_at
  )
`);

const getRunStmt = db.prepare(`
  SELECT * FROM runs WHERE run_id = ?
`);

const listRunsStmt = db.prepare(`
  SELECT * FROM runs ORDER BY created_at DESC LIMIT ? OFFSET ?
`);

const listRunsByProjectStmt = db.prepare(`
  SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
`);

const countRunsStmt = db.prepare(`
  SELECT COUNT(*) as count FROM runs
`);

const countRunsByProjectStmt = db.prepare(`
  SELECT COUNT(*) as count FROM runs WHERE project_id = ?
`);

const deleteRunStmt = db.prepare(`
  DELETE FROM runs WHERE run_id = ?
`);

const updateRunStmt = db.prepare(`
  UPDATE runs SET updated_at = @updated_at,
    final_report = @final_report, error = @error
  WHERE run_id = @run_id
`);

// Transaction wrappers for atomic operations
const markFailedTransaction = db.transaction((params: {
  run_id: string;
  project_id: string | null;
  user_goal: string;
  repo_path: string;
  mode: string;
  error: string;
  created_at: string;
  updated_at: string;
}) => {
  insertRunStmt.run({
    run_id: params.run_id,
    project_id: params.project_id,
    user_goal: params.user_goal,
    repo_path: params.repo_path,
    mode: params.mode,
    final_report: null,
    error: params.error,
    dag_json: null,
    dag_progress_json: null,
    created_at: params.created_at,
    updated_at: params.updated_at,
  });
});

const setRunningTransaction = db.transaction((params: {
  run_id: string;
  project_id: string | null;
  user_goal: string;
  repo_path: string;
  mode: string;
  created_at: string;
  updated_at: string;
}) => {
  insertRunStmt.run({
    run_id: params.run_id,
    project_id: params.project_id,
    user_goal: params.user_goal,
    repo_path: params.repo_path,
    mode: params.mode,
    final_report: null,
    error: null,
    dag_json: null,
    dag_progress_json: null,
    created_at: params.created_at,
    updated_at: params.updated_at,
  });
});

interface RunRow {
  run_id: string;
  project_id: string | null;
  user_goal: string;
  repo_path: string;
  mode: string;
  final_report: string | null;
  error: string | null;
  dag_json: string | null;
  dag_progress_json: string | null;
  created_at: string;
  updated_at: string;
}

/** Default page size */
const DEFAULT_PAGE_SIZE = 20;

/** Maximum page size */
const MAX_PAGE_SIZE = 100;

/** Pagination options */
export interface PaginationOptions {
  page?: number;      // 1-indexed page number (default: 1)
  pageSize?: number;  // Items per page (default: 20, max: 100)
}

/** Paginated list result */
export interface PaginatedRunList {
  runs: RunResponse[];
  pagination: {
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
}

/**
 * Helper to convert DB row to RunResponse
 */
function rowToRunResponse(row: RunRow): RunResponse {
  let actualStatus: RunResponse['status'];

  if (row.final_report) {
    actualStatus = 'completed';
  } else if (row.error) {
    actualStatus = 'failed';
  } else {
    actualStatus = 'interrupted';
  }

  return {
    run_id: row.run_id,
    project_id: row.project_id ?? undefined,
    mode: (row.mode || 'implementation') as RunMode,
    status: actualStatus,
    user_goal: row.user_goal,
    created_at: row.created_at,
    updated_at: row.updated_at,
    verification_passed: actualStatus === 'completed',
    error: row.error ?? undefined,
    final_report: row.final_report ?? undefined,
  };
}

/**
 * Run store for Supervisor Agent execution
 * Persists completed runs to SQLite database
 */
class RunStore {
  private runs: Map<string, SimplifiedSupervisorStateType> = new Map();
  private runningPromises: Map<string, Promise<SimplifiedSupervisorStateType>> = new Map();
  private runningGoals: Map<string, string> = new Map();
  private runningStartTimes: Map<string, string> = new Map();
  private runProjectIds: Map<string, string> = new Map();
  private runRepoPaths: Map<string, string> = new Map();
  private runModes: Map<string, RunMode> = new Map();

  /**
   * Store a run state (and persist to DB)
   */
  set(runId: string, state: SimplifiedSupervisorStateType): void {
    this.runs.set(runId, state);
    this.runningPromises.delete(runId);
    this.persistToDb(runId, state);
    // Clean up all associated tracking data
    this.cleanupRunTracking(runId);
  }

  /**
   * Clean up all tracking data for a run
   */
  private cleanupRunTracking(runId: string): void {
    this.runningGoals.delete(runId);
    this.runningStartTimes.delete(runId);
    this.runProjectIds.delete(runId);
    this.runRepoPaths.delete(runId);
    this.runModes.delete(runId);
  }

  /**
   * Convert a database row to SimplifiedSupervisorStateType
   * Type-safe conversion with proper validation
   */
  private rowToState(row: RunRow): SimplifiedSupervisorStateType {
    // Determine status based on row content
    let status: SimplifiedSupervisorStateType['status'];
    if (row.final_report) {
      status = 'completed';
    } else if (row.error) {
      status = 'failed';
    } else {
      status = 'failed'; // Interrupted runs are treated as failed
    }

    return {
      run_id: row.run_id,
      project_id: row.project_id || undefined,
      status,
      user_goal: row.user_goal,
      repo_path: row.repo_path,
      created_at: row.created_at,
      updated_at: row.updated_at,
      final_summary: row.final_report || undefined,
      error: row.error || undefined,
      reports: [],
      supervisor_thinking: undefined,
      worker_pool: undefined,
    };
  }

  /**
   * Persist run state to database
   * @throws DatabaseError if persistence fails (critical for data integrity)
   */
  private persistToDb(runId: string, state: SimplifiedSupervisorStateType): void {
    try {
      logger.debug('Persisting run to DB', { runId });
      insertRunStmt.run({
        run_id: state.run_id,
        project_id: state.project_id || this.runProjectIds.get(runId) || null,
        user_goal: state.user_goal,
        repo_path: state.repo_path || this.runRepoPaths.get(runId) || '',
        mode: this.runModes.get(runId) || 'implementation',
        final_report: state.final_summary || null,
        error: state.error || null,
        dag_json: null,
        dag_progress_json: null,
        created_at: state.created_at,
        updated_at: state.updated_at,
      });
      logger.debug('Successfully persisted run to DB', { runId });
    } catch (err) {
      const errorMsg = getErrorMessage(err);
      logger.error('Failed to persist run to DB', { runId, error: errorMsg });
      throw new DatabaseError(`Failed to persist run ${runId}`, { runId, originalError: errorMsg });
    }
  }

  /**
   * Update run data in database
   * @throws DatabaseError if update fails
   */
  updateRun(runId: string, state: SimplifiedSupervisorStateType): void {
    try {
      updateRunStmt.run({
        run_id: runId,
        updated_at: state.updated_at,
        final_report: state.final_summary || null,
        error: state.error || null,
      });
    } catch (err) {
      const errorMsg = getErrorMessage(err);
      logger.error('Failed to update run in DB', { runId, error: errorMsg });
      throw new DatabaseError(`Failed to update run ${runId}`, { runId, originalError: errorMsg });
    }
  }

  /**
   * Get a run state (from memory or DB)
   */
  get(runId: string): SimplifiedSupervisorStateType | undefined {
    const memState = this.runs.get(runId);
    if (memState) return memState;

    try {
      const row = getRunStmt.get(runId) as RunRow | undefined;
      if (row) {
        return this.rowToState(row);
      }
    } catch (err) {
      const errorMsg = getErrorMessage(err);
      logger.error('Failed to load run from DB', { runId, error: errorMsg });
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
    this.cleanupRunTracking(runId);
    const memDeleted = this.runs.delete(runId);

    try {
      const result = deleteRunStmt.run(runId);
      return memDeleted || result.changes > 0;
    } catch (err) {
      const errorMsg = getErrorMessage(err);
      logger.error('Failed to delete run from DB', { runId, error: errorMsg });
      return memDeleted;
    }
  }

  /**
   * Mark a run as failed (used when run fails before set() is called)
   * Uses transaction for atomic database update
   */
  markFailed(runId: string, error: string): void {
    const goal = this.runningGoals.get(runId);
    const repoPath = this.runRepoPaths.get(runId);
    const projectId = this.runProjectIds.get(runId);
    const mode = this.runModes.get(runId) || 'implementation';
    const startTime = this.runningStartTimes.get(runId);
    const now = new Date().toISOString();

    // Remove from running
    this.runningPromises.delete(runId);

    // Persist failed state using transaction
    try {
      markFailedTransaction({
        run_id: runId,
        project_id: projectId || null,
        user_goal: goal || '',
        repo_path: repoPath || '',
        mode,
        error: error,
        created_at: startTime || now,
        updated_at: now,
      });
    } catch (err) {
      const errorMsg = getErrorMessage(err);
      logger.error('Failed to mark run as failed', { runId, error: errorMsg });
    }

    // Cleanup tracking
    this.cleanupRunTracking(runId);
  }

  /**
   * List all runs with pagination support
   */
  list(options?: PaginationOptions): PaginatedRunList {
    const page = Math.max(1, options?.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, options?.pageSize ?? DEFAULT_PAGE_SIZE));
    const offset = (page - 1) * pageSize;

    const runningIds = new Set(this.runningPromises.keys());
    const runningCount = runningIds.size;

    const running = Array.from(runningIds).map(runId => ({
      run_id: runId,
      project_id: this.runProjectIds.get(runId),
      mode: this.runModes.get(runId) || 'implementation' as RunMode,
      status: 'running' as const,
      user_goal: this.runningGoals.get(runId) ?? 'Unknown goal',
      created_at: this.runningStartTimes.get(runId) ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));

    try {
      // Get total count from DB
      const countResult = countRunsStmt.get() as { count: number };
      const dbTotalCount = countResult.count;
      const totalCount = runningCount + dbTotalCount;

      // Calculate offset considering running tasks
      let runs: RunResponse[];
      if (offset < runningCount) {
        // Page includes some running tasks
        const runningSlice = running.slice(offset, offset + pageSize);
        const remainingSlots = pageSize - runningSlice.length;
        if (remainingSlots > 0) {
          const rows = listRunsStmt.all(remainingSlots, 0) as RunRow[];
          const fromDb = rows
            .filter(row => !runningIds.has(row.run_id))
            .map(rowToRunResponse);
          runs = [...runningSlice, ...fromDb];
        } else {
          runs = runningSlice;
        }
      } else {
        // Page is entirely from DB
        const dbOffset = offset - runningCount;
        const rows = listRunsStmt.all(pageSize, dbOffset) as RunRow[];
        runs = rows
          .filter(row => !runningIds.has(row.run_id))
          .map(rowToRunResponse);
      }

      const totalPages = Math.ceil(totalCount / pageSize);

      return {
        runs,
        pagination: {
          page,
          pageSize,
          totalCount,
          totalPages,
          hasNextPage: page < totalPages,
          hasPreviousPage: page > 1,
        },
      };
    } catch (err) {
      const errorMsg = getErrorMessage(err);
      logger.error('Failed to list runs from DB', { error: errorMsg });
      return {
        runs: running.slice(offset, offset + pageSize),
        pagination: {
          page,
          pageSize,
          totalCount: runningCount,
          totalPages: Math.ceil(runningCount / pageSize),
          hasNextPage: false,
          hasPreviousPage: page > 1,
        },
      };
    }
  }

  /**
   * List runs by project ID with pagination support
   */
  listByProject(projectId: string, options?: PaginationOptions): PaginatedRunList {
    const page = Math.max(1, options?.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, options?.pageSize ?? DEFAULT_PAGE_SIZE));
    const offset = (page - 1) * pageSize;

    const runningIds = new Set(
      Array.from(this.runningPromises.keys())
        .filter(runId => this.runProjectIds.get(runId) === projectId)
    );
    const runningCount = runningIds.size;

    const running = Array.from(runningIds).map(runId => ({
      run_id: runId,
      project_id: projectId,
      mode: this.runModes.get(runId) || 'implementation' as RunMode,
      status: 'running' as const,
      user_goal: this.runningGoals.get(runId) ?? 'Unknown goal',
      created_at: this.runningStartTimes.get(runId) ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));

    try {
      // Get total count from DB
      const countResult = countRunsByProjectStmt.get(projectId) as { count: number };
      const dbTotalCount = countResult.count;
      const totalCount = runningCount + dbTotalCount;

      // Calculate offset considering running tasks
      let runs: RunResponse[];
      if (offset < runningCount) {
        // Page includes some running tasks
        const runningSlice = running.slice(offset, offset + pageSize);
        const remainingSlots = pageSize - runningSlice.length;
        if (remainingSlots > 0) {
          const rows = listRunsByProjectStmt.all(projectId, remainingSlots, 0) as RunRow[];
          const fromDb = rows
            .filter(row => !runningIds.has(row.run_id))
            .map(rowToRunResponse);
          runs = [...runningSlice, ...fromDb];
        } else {
          runs = runningSlice;
        }
      } else {
        // Page is entirely from DB
        const dbOffset = offset - runningCount;
        const rows = listRunsByProjectStmt.all(projectId, pageSize, dbOffset) as RunRow[];
        runs = rows
          .filter(row => !runningIds.has(row.run_id))
          .map(rowToRunResponse);
      }

      const totalPages = Math.ceil(totalCount / pageSize);

      return {
        runs,
        pagination: {
          page,
          pageSize,
          totalCount,
          totalPages,
          hasNextPage: page < totalPages,
          hasPreviousPage: page > 1,
        },
      };
    } catch (err) {
      const errorMsg = getErrorMessage(err);
      logger.error('Failed to list project runs from DB', { error: errorMsg });
      return {
        runs: running.slice(offset, offset + pageSize),
        pagination: {
          page,
          pageSize,
          totalCount: runningCount,
          totalPages: Math.ceil(runningCount / pageSize),
          hasNextPage: false,
          hasPreviousPage: page > 1,
        },
      };
    }
  }

  /**
   * Track a running promise
   * Uses transaction for atomic database insertion
   */
  setRunning(runId: string, promise: Promise<SimplifiedSupervisorStateType>, goal?: string, projectId?: string, repoPath?: string, mode?: RunMode): void {
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
    this.runModes.set(runId, mode || 'implementation');
    const now = new Date().toISOString();
    this.runningStartTimes.set(runId, now);

    try {
      setRunningTransaction({
        run_id: runId,
        project_id: projectId || null,
        user_goal: goal || '',
        repo_path: repoPath || '',
        mode: mode || 'implementation',
        created_at: now,
        updated_at: now,
      });
    } catch (err) {
      const errorMsg = getErrorMessage(err);
      logger.error('Failed to insert placeholder run', { runId, error: errorMsg });
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
  async waitFor(runId: string): Promise<SimplifiedSupervisorStateType | undefined> {
    const promise = this.runningPromises.get(runId);
    if (promise) {
      return promise;
    }
    return this.get(runId);
  }

  /**
   * Convert state to response format
   */
  toResponse(state: SimplifiedSupervisorStateType, mode?: RunMode): RunResponse {
    return {
      run_id: state.run_id,
      project_id: state.project_id,
      mode: mode || this.runModes.get(state.run_id) || 'implementation',
      status: state.status,
      user_goal: state.user_goal,
      created_at: state.created_at,
      updated_at: state.updated_at,
      verification_passed: state.status === 'completed',
      error: state.error,
      final_report: state.final_summary,
    };
  }

  /**
   * Get mode for a run
   */
  getMode(runId: string): RunMode {
    return this.runModes.get(runId) || 'implementation';
  }

  /**
   * Set mode for a run (for spec mode runs)
   */
  setMode(runId: string, mode: RunMode): void {
    this.runModes.set(runId, mode);
  }

  /**
   * Get Worker Pool response
   * Note: Worker pool info is not persisted in simplified state.
   * This returns null for completed runs.
   * For running runs, use the WorkerPool instance directly via SupervisorAgent.
   * @deprecated This method always returns null - worker pool state is only
   * available during active runs via the SupervisorAgent instance.
   */
  getWorkerPool(_runId: string): WorkerPoolResponse | null {
    // Worker pool state is transient - not persisted after run completion.
    // For active runs, access via agentStore.get(runId).getWorkerPool()
    return null;
  }

  /**
   * Clear all runs
   */
  clear(): void {
    this.runs.clear();
    this.runningPromises.clear();
    this.runningGoals.clear();
    this.runningStartTimes.clear();
    this.runProjectIds.clear();
    this.runRepoPaths.clear();
    this.runModes.clear();
  }
}

// Singleton instances
export const runStore = new RunStore();

// Alias for backwards compatibility
export const parallelRunStore = runStore;
