/**
 * Run store with SQLite persistence
 * Uses in-memory for running state, persists completed runs to database
 */

import type { SimplifiedSupervisorStateType } from '../graph/index.js';
import type { RunResponse, WorkerPoolResponse } from './types.js';
import { db } from '../services/db.js';

// Prepared statements for runs table
const insertRunStmt = db.prepare(`
  INSERT OR REPLACE INTO runs (
    run_id, project_id, user_goal, repo_path,
    final_report, error, dag_json, dag_progress_json,
    created_at, updated_at
  ) VALUES (
    @run_id, @project_id, @user_goal, @repo_path,
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

const updateRunStmt = db.prepare(`
  UPDATE runs SET updated_at = @updated_at,
    final_report = @final_report, error = @error
  WHERE run_id = @run_id
`);

interface RunRow {
  run_id: string;
  project_id: string | null;
  user_goal: string;
  repo_path: string;
  final_report: string | null;
  error: string | null;
  dag_json: string | null;
  dag_progress_json: string | null;
  created_at: string;
  updated_at: string;
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
  }

  /**
   * Persist run state to database
   */
  private persistToDb(runId: string, state: SimplifiedSupervisorStateType): void {
    try {
      console.log(`[RunStore] Persisting run ${runId} to DB`);
      insertRunStmt.run({
        run_id: state.run_id,
        project_id: state.project_id || this.runProjectIds.get(runId) || null,
        user_goal: state.user_goal,
        repo_path: state.repo_path || this.runRepoPaths.get(runId) || '',
        final_report: state.final_summary || null,
        error: state.error || null,
        dag_json: null,
        dag_progress_json: null,
        created_at: state.created_at,
        updated_at: state.updated_at,
      });
      console.log(`[RunStore] Successfully persisted run ${runId}`);
    } catch (err) {
      console.error('[RunStore] Failed to persist run to DB:', err);
    }
  }

  /**
   * Update run data in database
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
      console.error('[RunStore] Failed to update run in DB:', err);
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
        let actualStatus: SimplifiedSupervisorStateType['status'];
        if (row.final_report) {
          actualStatus = 'completed';
        } else if (row.error) {
          actualStatus = 'failed';
        } else {
          actualStatus = 'failed';
        }

        const state = {
          run_id: row.run_id,
          project_id: row.project_id || undefined,
          status: actualStatus,
          user_goal: row.user_goal,
          repo_path: row.repo_path,
          created_at: row.created_at,
          updated_at: row.updated_at,
          final_summary: row.final_report || undefined,
          error: row.error || undefined,
          reports: [],
        } as unknown as SimplifiedSupervisorStateType;
        return state;
      }
    } catch (err) {
      console.error('[RunStore] Failed to load run from DB:', err);
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
      console.error('[RunStore] Failed to delete run from DB:', err);
      return memDeleted;
    }
  }

  /**
   * Mark a run as failed (used when run fails before set() is called)
   */
  markFailed(runId: string, error: string): void {
    const goal = this.runningGoals.get(runId);
    const repoPath = this.runRepoPaths.get(runId);
    const projectId = this.runProjectIds.get(runId);
    const startTime = this.runningStartTimes.get(runId);
    const now = new Date().toISOString();

    // Remove from running
    this.runningPromises.delete(runId);

    // Persist failed state
    try {
      insertRunStmt.run({
        run_id: runId,
        project_id: projectId || null,
        user_goal: goal || '',
        repo_path: repoPath || '',
        final_report: null,
        error: error,
        dag_json: null,
        dag_progress_json: null,
        created_at: startTime || now,
        updated_at: now,
      });
    } catch (err) {
      console.error('[RunStore] Failed to mark run as failed:', err);
    }

    // Cleanup tracking
    this.cleanupRunTracking(runId);
  }

  /**
   * List all runs
   */
  list(): RunResponse[] {
    const runningIds = new Set(this.runningPromises.keys());

    const running = Array.from(runningIds).map(runId => ({
      run_id: runId,
      project_id: this.runProjectIds.get(runId),
      status: 'running' as const,
      user_goal: this.runningGoals.get(runId) ?? 'Unknown goal',
      created_at: this.runningStartTimes.get(runId) ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));

    try {
      const rows = listRunsStmt.all() as RunRow[];
      const fromDb = rows
        .filter(row => !runningIds.has(row.run_id))
        .map(rowToRunResponse);
      return [...running, ...fromDb];
    } catch (err) {
      console.error('[RunStore] Failed to list runs from DB:', err);
      return running;
    }
  }

  /**
   * List runs by project ID
   */
  listByProject(projectId: string): RunResponse[] {
    const runningIds = new Set(
      Array.from(this.runningPromises.keys())
        .filter(runId => this.runProjectIds.get(runId) === projectId)
    );

    const running = Array.from(runningIds).map(runId => ({
      run_id: runId,
      project_id: projectId,
      status: 'running' as const,
      user_goal: this.runningGoals.get(runId) ?? 'Unknown goal',
      created_at: this.runningStartTimes.get(runId) ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));

    try {
      const rows = listRunsByProjectStmt.all(projectId) as RunRow[];
      const fromDb = rows
        .filter(row => !runningIds.has(row.run_id))
        .map(rowToRunResponse);
      return [...running, ...fromDb];
    } catch (err) {
      console.error('[RunStore] Failed to list project runs from DB:', err);
      return running;
    }
  }

  /**
   * Track a running promise
   */
  setRunning(runId: string, promise: Promise<SimplifiedSupervisorStateType>, goal?: string, projectId?: string, repoPath?: string): void {
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
    const now = new Date().toISOString();
    this.runningStartTimes.set(runId, now);

    try {
      insertRunStmt.run({
        run_id: runId,
        project_id: projectId || null,
        user_goal: goal || '',
        repo_path: repoPath || '',
        final_report: null,
        error: null,
        dag_json: null,
        dag_progress_json: null,
        created_at: now,
        updated_at: now,
      });
    } catch (err) {
      console.error('[RunStore] Failed to insert placeholder run:', err);
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
  toResponse(state: SimplifiedSupervisorStateType): RunResponse {
    return {
      run_id: state.run_id,
      project_id: state.project_id,
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
   * Get Worker Pool response (not available in simplified state)
   */
  getWorkerPool(_runId: string): WorkerPoolResponse | null {
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
  }
}

// Singleton instances
export const runStore = new RunStore();

// Alias for backwards compatibility
export const parallelRunStore = runStore;
