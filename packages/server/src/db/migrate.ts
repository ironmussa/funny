import { db } from './index.js';
import { sql } from 'drizzle-orm';
import { log } from '../lib/abbacchio.js';

// ── Migration tracking ──────────────────────────────────────────

interface Migration {
  name: string;
  up: () => void;
}

function ensureMigrationTable() {
  db.run(sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
}

function hasRun(name: string): boolean {
  const row = db.get<{ name: string }>(sql`SELECT name FROM _migrations WHERE name = ${name}`);
  return !!row;
}

function markRun(name: string) {
  db.run(sql`INSERT INTO _migrations (name, applied_at) VALUES (${name}, ${new Date().toISOString()})`);
}

/** Helper to safely add a column (idempotent) */
function addColumn(table: string, column: string, type: string, dflt?: string) {
  try {
    const defaultClause = dflt !== undefined ? ` DEFAULT ${dflt}` : '';
    db.run(sql.raw(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}${defaultClause}`));
  } catch {
    // Column already exists
  }
}

// ── Migrations ──────────────────────────────────────────────────
// IMPORTANT: Never modify existing migrations. Always append new ones.

const migrations: Migration[] = [
  {
    name: '001_initial_tables',
    up() {
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

      db.run(sql`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          timestamp TEXT NOT NULL
        )
      `);

      db.run(sql`
        CREATE TABLE IF NOT EXISTS tool_calls (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          input TEXT,
          output TEXT
        )
      `);
    },
  },

  {
    name: '002_thread_extras',
    up() {
      addColumn('threads', 'archived', 'INTEGER NOT NULL', '0');
      addColumn('threads', 'permission_mode', "TEXT NOT NULL", "'autoEdit'");
      addColumn('threads', 'base_branch', 'TEXT');
    },
  },

  {
    name: '003_message_extras',
    up() {
      addColumn('messages', 'images', 'TEXT');
      addColumn('messages', 'model', 'TEXT');
      addColumn('messages', 'permission_mode', 'TEXT');
    },
  },

  {
    name: '004_startup_commands',
    up() {
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
      addColumn('startup_commands', 'port', 'INTEGER');
      addColumn('startup_commands', 'port_env_var', 'TEXT');
    },
  },

  {
    name: '005_automations',
    up() {
      addColumn('threads', 'automation_id', 'TEXT');

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
    },
  },

  {
    name: '006_mcp_oauth',
    up() {
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
    },
  },

  {
    name: '007_multi_user',
    up() {
      addColumn('projects', 'user_id', "TEXT NOT NULL", "'__local__'");
      addColumn('threads', 'user_id', "TEXT NOT NULL", "'__local__'");
      addColumn('automations', 'user_id', "TEXT NOT NULL", "'__local__'");

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
    },
  },

  {
    name: '008_kanban_and_stage_history',
    up() {
      addColumn('threads', 'pinned', 'INTEGER NOT NULL', '0');
      addColumn('threads', 'stage', "TEXT NOT NULL", "'backlog'");

      db.run(sql`
        CREATE TABLE IF NOT EXISTS stage_history (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          from_stage TEXT,
          to_stage TEXT NOT NULL,
          changed_at TEXT NOT NULL
        )
      `);

      // Backfill stages based on current status
      db.run(sql`UPDATE threads SET stage = 'in_progress' WHERE status IN ('running', 'waiting') AND stage = 'backlog'`);
      db.run(sql`UPDATE threads SET stage = 'review' WHERE status IN ('completed', 'failed', 'stopped', 'interrupted') AND stage = 'backlog'`);

      // Backfill stage_history for threads without history
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
    },
  },

  {
    name: '009_project_extras',
    up() {
      addColumn('projects', 'sort_order', 'INTEGER NOT NULL', '0');
      addColumn('projects', 'color', 'TEXT');
    },
  },

  {
    name: '010_idle_threads',
    up() {
      addColumn('threads', 'initial_prompt', 'TEXT');
      addColumn('threads', 'model', "TEXT NOT NULL", "'sonnet'");
    },
  },

  {
    name: '011_multi_provider',
    up() {
      addColumn('threads', 'provider', "TEXT NOT NULL", "'claude'");
      addColumn('automations', 'provider', "TEXT NOT NULL", "'claude'");
    },
  },

  {
    name: '012_external_threads',
    up() {
      addColumn('threads', 'external_request_id', 'TEXT');
    },
  },

  {
    name: '013_thread_comments',
    up() {
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
    },
  },

  {
    name: '014_init_info',
    up() {
      addColumn('threads', 'init_tools', 'TEXT');
      addColumn('threads', 'init_cwd', 'TEXT');
    },
  },

  {
    name: '015_indexes',
    up() {
      db.run(sql`
        CREATE INDEX IF NOT EXISTS idx_messages_thread_timestamp
        ON messages (thread_id, timestamp)
      `);
      db.run(sql`
        CREATE INDEX IF NOT EXISTS idx_threads_project_id
        ON threads (project_id)
      `);
      db.run(sql`
        CREATE INDEX IF NOT EXISTS idx_threads_user_archived
        ON threads (user_id, archived)
      `);
    },
  },

  {
    name: '016_fts5_search',
    up() {
      // FTS5 virtual table for message content search
      db.run(sql`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
        USING fts5(content, content=messages, content_rowid=rowid)
      `);

      // Triggers to keep FTS index in sync
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

      // Backfill FTS index for existing messages
      const ftsCount = db.get<{ count: number }>(sql`SELECT COUNT(*) as count FROM messages_fts`);
      if (ftsCount && ftsCount.count === 0) {
        const msgCount = db.get<{ count: number }>(sql`SELECT COUNT(*) as count FROM messages`);
        if (msgCount && msgCount.count > 0) {
          log.info(`Backfilling FTS index for ${msgCount.count} messages`, { namespace: 'db' });
          db.run(sql`INSERT INTO messages_fts(rowid, content) SELECT rowid, content FROM messages`);
          log.info('FTS backfill complete', { namespace: 'db' });
        }
      }
    },
  },

  {
    name: '017_follow_up_mode',
    up() {
      addColumn('projects', 'follow_up_mode', "TEXT NOT NULL", "'interrupt'");

      db.run(sql`
        CREATE TABLE IF NOT EXISTS message_queue (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          content TEXT NOT NULL,
          provider TEXT,
          model TEXT,
          permission_mode TEXT,
          images TEXT,
          allowed_tools TEXT,
          disallowed_tools TEXT,
          file_references TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        )
      `);

      db.run(sql`
        CREATE INDEX IF NOT EXISTS idx_message_queue_thread
        ON message_queue (thread_id, sort_order)
      `);
    },
  },

  {
    name: '018_thread_source',
    up() {
      addColumn('threads', 'source', "TEXT NOT NULL", "'web'");
    },
  },
];

// ── Public API ──────────────────────────────────────────────────

/**
 * Run all pending migrations in order.
 * Each migration runs exactly once, tracked by the _migrations table.
 * Existing databases (pre-migration-tracking) are handled gracefully
 * because each migration uses CREATE TABLE IF NOT EXISTS / addColumn.
 */
export function autoMigrate() {
  ensureMigrationTable();

  let applied = 0;
  for (const migration of migrations) {
    if (hasRun(migration.name)) continue;

    try {
      migration.up();
      markRun(migration.name);
      applied++;
    } catch (err) {
      log.error(`Migration ${migration.name} failed`, { namespace: 'db', error: err });
      throw err;
    }
  }

  if (applied > 0) {
    log.info(`Applied ${applied} migration(s)`, { namespace: 'db' });
  }

  log.info('Tables ready', { namespace: 'db' });
}
