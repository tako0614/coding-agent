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
console.log(`[DB] Using database: ${dbPath}`);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

// Enable foreign key constraints (SQLite doesn't enforce them by default)
db.pragma('foreign_keys = ON');

// Set busy timeout to handle concurrent writes gracefully
db.pragma('busy_timeout = 5000');

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
    mode TEXT NOT NULL DEFAULT 'implementation',
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
  -- Index for SSE Last-Event-ID queries
  CREATE INDEX IF NOT EXISTS idx_run_logs_run_id_id ON run_logs(run_id, id);

  -- Parallel sessions state (stored as JSON array)
  CREATE TABLE IF NOT EXISTS parallel_sessions (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    sessions_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Initialize with empty array if not exists
  INSERT OR IGNORE INTO parallel_sessions (id, sessions_json, updated_at)
  VALUES (1, '[]', datetime('now'));

  -- Checkpoints for run state recovery
  CREATE TABLE IF NOT EXISTS checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    node_name TEXT NOT NULL,
    state_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_checkpoints_run_id ON checkpoints(run_id);
  CREATE INDEX IF NOT EXISTS idx_checkpoints_created_at ON checkpoints(run_id, created_at DESC);

  -- Cost tracking
  CREATE TABLE IF NOT EXISTS cost_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    executor_type TEXT NOT NULL,
    api_calls INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_cost_metrics_run_id ON cost_metrics(run_id);

  -- Spec agent conversations (for chat-based spec mode)
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL UNIQUE,
    messages_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_conversations_run_id ON conversations(run_id);

  -- Normalized conversation messages table (for better performance)
  -- Now supports conversation_id for branching
  CREATE TABLE IF NOT EXISTS conversation_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    conversation_id TEXT,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    tool_calls_json TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
    FOREIGN KEY (conversation_id) REFERENCES conversation_threads(conversation_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_conv_messages_run_id ON conversation_messages(run_id);
  CREATE INDEX IF NOT EXISTS idx_conv_messages_run_seq ON conversation_messages(run_id, seq);
  CREATE INDEX IF NOT EXISTS idx_conv_messages_conv_id ON conversation_messages(conversation_id);

  -- Structured specifications (machine-readable format)
  CREATE TABLE IF NOT EXISTS structured_specs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spec_run_id TEXT NOT NULL,
    spec_json TEXT NOT NULL,
    markdown TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (spec_run_id) REFERENCES runs(run_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_structured_specs_run_id ON structured_specs(spec_run_id);

  -- Link implementation runs to their source specs
  CREATE TABLE IF NOT EXISTS run_spec_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    impl_run_id TEXT NOT NULL,
    spec_run_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (impl_run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
    FOREIGN KEY (spec_run_id) REFERENCES runs(run_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_run_spec_links_impl ON run_spec_links(impl_run_id);
  CREATE INDEX IF NOT EXISTS idx_run_spec_links_spec ON run_spec_links(spec_run_id);

  -- Conversation threads (supports branching and re-execution)
  CREATE TABLE IF NOT EXISTS conversation_threads (
    conversation_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    parent_conversation_id TEXT,
    branch_point_seq INTEGER,
    name TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
    FOREIGN KEY (parent_conversation_id) REFERENCES conversation_threads(conversation_id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_conv_threads_run_id ON conversation_threads(run_id);
  CREATE INDEX IF NOT EXISTS idx_conv_threads_parent ON conversation_threads(parent_conversation_id);

  -- Spec agent sessions (for server restart recovery)
  CREATE TABLE IF NOT EXISTS spec_agent_sessions (
    run_id TEXT PRIMARY KEY,
    repo_path TEXT NOT NULL,
    model TEXT,
    created_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_spec_agent_sessions_last_active ON spec_agent_sessions(last_active_at DESC);
`);

// Check if conversation_messages table exists and has data
// If conversations has data but conversation_messages is empty, migrate
try {
  const hasOldData = db.prepare(`
    SELECT COUNT(*) as count FROM conversations WHERE messages_json IS NOT NULL
  `).get() as { count: number };

  const hasNewData = db.prepare(`
    SELECT COUNT(*) as count FROM conversation_messages
  `).get() as { count: number };

  if (hasOldData.count > 0 && hasNewData.count === 0) {
    console.log('[DB] Migrating conversation messages to normalized table...');
    const conversations = db.prepare(`
      SELECT run_id, messages_json, created_at FROM conversations
    `).all() as Array<{ run_id: string; messages_json: string; created_at: string }>;

    const insertMsg = db.prepare(`
      INSERT INTO conversation_messages (run_id, seq, role, content, tool_calls_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const conv of conversations) {
      try {
        const messages = JSON.parse(conv.messages_json) as Array<{
          role: string;
          content: string;
          timestamp?: string;
          tool_calls?: unknown;
        }>;
        let seq = 0;
        for (const msg of messages) {
          insertMsg.run(
            conv.run_id,
            seq++,
            msg.role,
            msg.content,
            msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
            msg.timestamp || conv.created_at
          );
        }
      } catch {
        // Skip malformed conversations
      }
    }
    console.log(`[DB] Migrated ${conversations.length} conversations`);
  }
} catch {
  // Table might not exist yet, ignore
}

// Migration: Add mode column if it doesn't exist (for existing databases)
try {
  db.exec(`ALTER TABLE runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'implementation'`);
} catch {
  // Column already exists, ignore
}

// Migration: Add conversation_id column to conversation_messages if it doesn't exist
try {
  db.exec(`ALTER TABLE conversation_messages ADD COLUMN conversation_id TEXT`);
  console.log('[DB] Added conversation_id column to conversation_messages');
} catch {
  // Column already exists, ignore
}
