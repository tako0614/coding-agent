import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const isPackaged = (process as NodeJS.Process & { pkg?: unknown }).pkg !== undefined;

const moduleDir = dirname(fileURLToPath(import.meta.url));
const defaultPath = isPackaged
  ? resolve(process.cwd(), 'data', 'supervisor.db')
  : resolve(moduleDir, '..', '..', 'data', 'supervisor.db');

const dbPath = process.env['SUPERVISOR_DB_PATH'] ?? defaultPath;
const dbDir = dirname(dbPath);

if (!existsSync(dbDir)) {
  mkdirSync(dbDir, { recursive: true });
}

export const db: DatabaseType = new Database(dbPath);

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    repo_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    project_id TEXT,
    user_goal TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    final_report TEXT,
    error TEXT,
    dag_json TEXT,
    dag_progress_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(project_id)
  );

  CREATE INDEX IF NOT EXISTS idx_runs_project_id ON runs(project_id);
  CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);

  -- Drop status column if it exists (migration for existing DBs)
  -- SQLite 3.35.0+ supports ALTER TABLE DROP COLUMN
  DROP INDEX IF EXISTS idx_runs_status;

  CREATE TABLE IF NOT EXISTS run_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    level TEXT NOT NULL,
    source TEXT NOT NULL,
    message TEXT NOT NULL,
    metadata_json TEXT,
    FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_run_logs_run_id ON run_logs(run_id);
  CREATE INDEX IF NOT EXISTS idx_run_logs_timestamp ON run_logs(run_id, timestamp);
`);
