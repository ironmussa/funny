import { db } from './index.js';
import { sql } from 'drizzle-orm';

/**
 * Auto-create tables on startup if they don't exist.
 */
export function autoMigrate() {
  db.run(sql`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      branch TEXT,
      worktree_path TEXT,
      session_id TEXT,
      cost REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )
  `);

  // Add archived column to existing tables that don't have it
  try {
    db.run(sql`ALTER TABLE threads ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists
  }

  // Add permission_mode column to existing tables that don't have it
  try {
    db.run(sql`ALTER TABLE threads ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'autoEdit'`);
  } catch {
    // Column already exists
  }

  // Add base_branch column to existing tables that don't have it
  try {
    db.run(sql`ALTER TABLE threads ADD COLUMN base_branch TEXT`);
  } catch {
    // Column already exists
  }

  db.run(sql`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL
    )
  `);

  // Add images column to existing tables that don't have it
  try {
    db.run(sql`ALTER TABLE messages ADD COLUMN images TEXT`);
  } catch {
    // Column already exists
  }

  // Add model column to messages (tracks which Claude model was used)
  try {
    db.run(sql`ALTER TABLE messages ADD COLUMN model TEXT`);
  } catch {
    // Column already exists
  }

  // Add permission_mode column to messages
  try {
    db.run(sql`ALTER TABLE messages ADD COLUMN permission_mode TEXT`);
  } catch {
    // Column already exists
  }

  db.run(sql`
    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      input TEXT,
      output TEXT
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS startup_commands (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      command TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);

  // Add port column to startup_commands
  try {
    db.run(sql`ALTER TABLE startup_commands ADD COLUMN port INTEGER`);
  } catch {
    // Column already exists
  }

  // Add port_env_var column to startup_commands
  try {
    db.run(sql`ALTER TABLE startup_commands ADD COLUMN port_env_var TEXT`);
  } catch {
    // Column already exists
  }

  // Add automation_id column to threads
  try {
    db.run(sql`ALTER TABLE threads ADD COLUMN automation_id TEXT`);
  } catch {
    // Column already exists
  }

  db.run(sql`
    CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'sonnet',
      mode TEXT NOT NULL DEFAULT 'worktree',
      permission_mode TEXT NOT NULL DEFAULT 'autoEdit',
      base_branch TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      max_run_history INTEGER NOT NULL DEFAULT 20,
      last_run_at TEXT,
      next_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'running',
      triage_status TEXT NOT NULL DEFAULT 'pending',
      has_findings INTEGER,
      summary TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
      id TEXT PRIMARY KEY,
      server_name TEXT NOT NULL,
      project_path TEXT NOT NULL,
      server_url TEXT NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      token_type TEXT NOT NULL DEFAULT 'Bearer',
      expires_at TEXT,
      scope TEXT,
      token_endpoint TEXT,
      client_id TEXT,
      client_secret TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Add user_id columns for multi-user support
  try {
    db.run(sql`ALTER TABLE projects ADD COLUMN user_id TEXT NOT NULL DEFAULT '__local__'`);
  } catch {
    // Column already exists
  }

  try {
    db.run(sql`ALTER TABLE threads ADD COLUMN user_id TEXT NOT NULL DEFAULT '__local__'`);
  } catch {
    // Column already exists
  }

  try {
    db.run(sql`ALTER TABLE automations ADD COLUMN user_id TEXT NOT NULL DEFAULT '__local__'`);
  } catch {
    // Column already exists
  }

  db.run(sql`
    CREATE TABLE IF NOT EXISTS user_profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      git_name TEXT,
      git_email TEXT,
      github_token TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS stage_history (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      from_stage TEXT,
      to_stage TEXT NOT NULL,
      changed_at TEXT NOT NULL
    )
  `);

  // Add pinned column to threads
  try {
    db.run(sql`ALTER TABLE threads ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists
  }

  // Add sort_order column to projects
  try {
    db.run(sql`ALTER TABLE projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists
  }

  // Add stage column to threads for Kanban workflow tracking
  try {
    db.run(sql`ALTER TABLE threads ADD COLUMN stage TEXT NOT NULL DEFAULT 'backlog'`);
  } catch {
    // Column already exists
  }

  // Add color column to projects
  try {
    db.run(sql`ALTER TABLE projects ADD COLUMN color TEXT`);
  } catch {
    // Column already exists
  }

  // Add initialPrompt column to threads for idle thread workflow
  try {
    db.run(sql`ALTER TABLE threads ADD COLUMN initial_prompt TEXT`);
  } catch {
    // Column already exists
  }

  // Add model column to threads to persist the Claude model selection
  try {
    db.run(sql`ALTER TABLE threads ADD COLUMN model TEXT NOT NULL DEFAULT 'sonnet'`);
  } catch {
    // Column already exists
  }

  // Add provider column to threads for multi-provider support
  try {
    db.run(sql`ALTER TABLE threads ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'`);
  } catch {
    // Column already exists
  }

  // Add provider column to automations for multi-provider support
  try {
    db.run(sql`ALTER TABLE automations ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'`);
  } catch {
    // Column already exists
  }

  // Add external_request_id column for external/webhook-created threads
  try {
    db.run(sql`ALTER TABLE threads ADD COLUMN external_request_id TEXT`);
  } catch {
    // Column already exists
  }

  // Backfill existing threads based on their current status
  db.run(sql`UPDATE threads SET stage = 'in_progress' WHERE status IN ('running', 'waiting') AND stage = 'backlog'`);
  db.run(sql`UPDATE threads SET stage = 'review' WHERE status IN ('completed', 'failed', 'stopped', 'interrupted') AND stage = 'backlog'`);

  // Backfill stage_history for existing threads that don't have any history yet
  db.run(sql`
    INSERT INTO stage_history (id, thread_id, from_stage, to_stage, changed_at)
    SELECT
      lower(hex(randomblob(16))),
      t.id,
      NULL,
      t.stage,
      t.created_at
    FROM threads t
    WHERE NOT EXISTS (
      SELECT 1 FROM stage_history sh WHERE sh.thread_id = t.id
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS thread_comments (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'user',
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Add init info columns to threads table
  try {
    db.run(sql`ALTER TABLE threads ADD COLUMN init_tools TEXT`);
  } catch {
    // Column already exists
  }
  try {
    db.run(sql`ALTER TABLE threads ADD COLUMN init_cwd TEXT`);
  } catch {
    // Column already exists
  }

  // Index for efficient paginated message queries
  db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_messages_thread_timestamp
    ON messages (thread_id, timestamp)
  `);

  // Indexes for efficient thread filtering (Kanban search, list queries)
  db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_threads_project_id
    ON threads (project_id)
  `);
  db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_threads_user_archived
    ON threads (user_id, archived)
  `);

  // FTS5 full-text search index for message content
  // Uses an external-content table linked to messages for zero storage duplication
  db.run(sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
    USING fts5(content, content=messages, content_rowid=rowid)
  `);

  // Triggers to keep FTS index in sync with the messages table
  db.run(sql`
    CREATE TRIGGER IF NOT EXISTS messages_fts_insert
    AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
    END
  `);
  db.run(sql`
    CREATE TRIGGER IF NOT EXISTS messages_fts_delete
    AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', OLD.rowid, OLD.content);
    END
  `);
  db.run(sql`
    CREATE TRIGGER IF NOT EXISTS messages_fts_update
    AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', OLD.rowid, OLD.content);
      INSERT INTO messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
    END
  `);

  // Backfill FTS index for existing messages that aren't indexed yet.
  // Only runs when the FTS table is empty (first migration with FTS).
  const ftsCount = db.get<{ count: number }>(sql`SELECT COUNT(*) as count FROM messages_fts`);
  if (ftsCount && ftsCount.count === 0) {
    const msgCount = db.get<{ count: number }>(sql`SELECT COUNT(*) as count FROM messages`);
    if (msgCount && msgCount.count > 0) {
      console.log(`[db] Backfilling FTS index for ${msgCount.count} messages...`);
      db.run(sql`INSERT INTO messages_fts(rowid, content) SELECT rowid, content FROM messages`);
      console.log('[db] FTS backfill complete');
    }
  }

  console.log('[db] Tables ready');
}
