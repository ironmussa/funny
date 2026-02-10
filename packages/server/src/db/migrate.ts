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

  console.log('[db] Tables ready');
}
