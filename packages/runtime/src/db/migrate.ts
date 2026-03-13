/**
 * @domain subdomain: Shared Kernel
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: Database
 *
 * Dual-dialect migration system — works with both SQLite and PostgreSQL.
 * SQLite migrations are synchronous (db.run/db.get).
 * PostgreSQL migrations are async (db.execute returns a Promise).
 */

import { sql } from 'drizzle-orm';

import { log } from '../lib/logger.js';
import { db, dbMode } from './index.js';

const isPg = dbMode === 'postgres';

// ── Dialect-aware query helpers ─────────────────────────────────
// SQLite Drizzle: db.run() / db.get() (synchronous)
// PG Drizzle:     db.execute() (async, returns Promise)

async function exec(query: ReturnType<typeof sql> | ReturnType<typeof sql.raw>): Promise<void> {
  if (isPg) {
    await (db as any).execute(query);
  } else {
    (db as any).run(query);
  }
}

async function queryOne<T>(
  query: ReturnType<typeof sql> | ReturnType<typeof sql.raw>,
): Promise<T | undefined> {
  if (isPg) {
    const rows = await (db as any).execute(query);
    return rows?.[0] as T | undefined;
  } else {
    return (db as any).get<T>(query);
  }
}

// ── Migration tracking ──────────────────────────────────────────

interface Migration {
  name: string;
  up: () => Promise<void>;
}

async function ensureMigrationTable() {
  await exec(sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
}

async function hasRun(name: string): Promise<boolean> {
  const row = await queryOne<{ name: string }>(
    sql`SELECT name FROM _migrations WHERE name = ${name}`,
  );
  return !!row;
}

async function markRun(name: string) {
  await exec(
    sql`INSERT INTO _migrations (name, applied_at) VALUES (${name}, ${new Date().toISOString()})`,
  );
}

/** Helper to safely add a column (idempotent) */
async function addColumn(table: string, column: string, type: string, dflt?: string) {
  try {
    const defaultClause = dflt !== undefined ? ` DEFAULT ${dflt}` : '';
    if (isPg) {
      await exec(
        sql.raw(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}${defaultClause}`),
      );
    } else {
      await exec(sql.raw(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}${defaultClause}`));
    }
  } catch {
    // Column already exists
  }
}

// ── Migrations ──────────────────────────────────────────────────
// IMPORTANT: Never modify existing migrations. Always append new ones.

const migrations: Migration[] = [
  {
    name: '001_initial_tables',
    async up() {
      await exec(sql`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          path TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);

      await exec(sql`
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

      await exec(sql`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          timestamp TEXT NOT NULL
        )
      `);

      await exec(sql`
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
    async up() {
      await addColumn('threads', 'archived', 'INTEGER NOT NULL', '0');
      await addColumn('threads', 'permission_mode', 'TEXT NOT NULL', "'autoEdit'");
      await addColumn('threads', 'base_branch', 'TEXT');
    },
  },

  {
    name: '003_message_extras',
    async up() {
      await addColumn('messages', 'images', 'TEXT');
      await addColumn('messages', 'model', 'TEXT');
      await addColumn('messages', 'permission_mode', 'TEXT');
    },
  },

  {
    name: '004_startup_commands',
    async up() {
      await exec(sql`
        CREATE TABLE IF NOT EXISTS startup_commands (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          label TEXT NOT NULL,
          command TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        )
      `);
      await addColumn('startup_commands', 'port', 'INTEGER');
      await addColumn('startup_commands', 'port_env_var', 'TEXT');
    },
  },

  {
    name: '005_automations',
    async up() {
      await addColumn('threads', 'automation_id', 'TEXT');

      await exec(sql`
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

      await exec(sql`
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
    async up() {
      await exec(sql`
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
    async up() {
      await addColumn('projects', 'user_id', 'TEXT NOT NULL', "'__local__'");
      await addColumn('threads', 'user_id', 'TEXT NOT NULL', "'__local__'");
      await addColumn('automations', 'user_id', 'TEXT NOT NULL', "'__local__'");

      await exec(sql`
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
    async up() {
      await addColumn('threads', 'pinned', 'INTEGER NOT NULL', '0');
      await addColumn('threads', 'stage', 'TEXT NOT NULL', "'backlog'");

      await exec(sql`
        CREATE TABLE IF NOT EXISTS stage_history (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          from_stage TEXT,
          to_stage TEXT NOT NULL,
          changed_at TEXT NOT NULL
        )
      `);

      await exec(
        sql`UPDATE threads SET stage = 'in_progress' WHERE status IN ('running', 'waiting') AND stage = 'backlog'`,
      );
      await exec(
        sql`UPDATE threads SET stage = 'review' WHERE status IN ('completed', 'failed', 'stopped', 'interrupted') AND stage = 'backlog'`,
      );

      if (isPg) {
        await exec(sql`
          INSERT INTO stage_history (id, thread_id, from_stage, to_stage, changed_at)
          SELECT
            md5(random()::text),
            t.id,
            NULL,
            t.stage,
            t.created_at
          FROM threads t
          WHERE NOT EXISTS (
            SELECT 1 FROM stage_history sh WHERE sh.thread_id = t.id
          )
        `);
      } else {
        await exec(sql`
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
      }
    },
  },

  {
    name: '009_project_extras',
    async up() {
      await addColumn('projects', 'sort_order', 'INTEGER NOT NULL', '0');
      await addColumn('projects', 'color', 'TEXT');
    },
  },

  {
    name: '010_idle_threads',
    async up() {
      await addColumn('threads', 'initial_prompt', 'TEXT');
      await addColumn('threads', 'model', 'TEXT NOT NULL', "'sonnet'");
    },
  },

  {
    name: '011_multi_provider',
    async up() {
      await addColumn('threads', 'provider', 'TEXT NOT NULL', "'claude'");
      await addColumn('automations', 'provider', 'TEXT NOT NULL', "'claude'");
    },
  },

  {
    name: '012_external_threads',
    async up() {
      await addColumn('threads', 'external_request_id', 'TEXT');
    },
  },

  {
    name: '013_thread_comments',
    async up() {
      await exec(sql`
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
    async up() {
      await addColumn('threads', 'init_tools', 'TEXT');
      await addColumn('threads', 'init_cwd', 'TEXT');
    },
  },

  {
    name: '015_indexes',
    async up() {
      await exec(sql`
        CREATE INDEX IF NOT EXISTS idx_messages_thread_timestamp
        ON messages (thread_id, timestamp)
      `);
      await exec(sql`
        CREATE INDEX IF NOT EXISTS idx_threads_project_id
        ON threads (project_id)
      `);
      await exec(sql`
        CREATE INDEX IF NOT EXISTS idx_threads_user_archived
        ON threads (user_id, archived)
      `);
    },
  },

  {
    name: '016_fts5_search',
    async up() {
      if (isPg) {
        await addColumn('messages', 'search_vector', 'TSVECTOR');

        await exec(sql`
          CREATE INDEX IF NOT EXISTS idx_messages_search_vector
          ON messages USING GIN (search_vector)
        `);

        await exec(
          sql.raw(`
          CREATE OR REPLACE FUNCTION messages_search_vector_update() RETURNS trigger AS $$
          BEGIN
            NEW.search_vector := to_tsvector('english', COALESCE(NEW.content, ''));
            RETURN NEW;
          END
          $$ LANGUAGE plpgsql
        `),
        );

        await exec(
          sql.raw(`
          DROP TRIGGER IF EXISTS messages_search_vector_trigger ON messages
        `),
        );
        await exec(
          sql.raw(`
          CREATE TRIGGER messages_search_vector_trigger
          BEFORE INSERT OR UPDATE ON messages
          FOR EACH ROW EXECUTE FUNCTION messages_search_vector_update()
        `),
        );

        await exec(sql`
          UPDATE messages
          SET search_vector = to_tsvector('english', COALESCE(content, ''))
          WHERE search_vector IS NULL
        `);
      } else {
        await exec(sql`
          CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
          USING fts5(content, content=messages, content_rowid=rowid)
        `);

        await exec(sql`
          CREATE TRIGGER IF NOT EXISTS messages_fts_insert
          AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
          END
        `);
        await exec(sql`
          CREATE TRIGGER IF NOT EXISTS messages_fts_delete
          AFTER DELETE ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', OLD.rowid, OLD.content);
          END
        `);
        await exec(sql`
          CREATE TRIGGER IF NOT EXISTS messages_fts_update
          AFTER UPDATE ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', OLD.rowid, OLD.content);
            INSERT INTO messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
          END
        `);

        const ftsCount = await queryOne<{ count: number }>(
          sql`SELECT COUNT(*) as count FROM messages_fts`,
        );
        if (ftsCount && ftsCount.count === 0) {
          const msgCount = await queryOne<{ count: number }>(
            sql`SELECT COUNT(*) as count FROM messages`,
          );
          if (msgCount && msgCount.count > 0) {
            log.info(`Backfilling FTS index for ${msgCount.count} messages`, { namespace: 'db' });
            await exec(
              sql`INSERT INTO messages_fts(rowid, content) SELECT rowid, content FROM messages`,
            );
            log.info('FTS backfill complete', { namespace: 'db' });
          }
        }
      }
    },
  },

  {
    name: '017_follow_up_mode',
    async up() {
      await addColumn('projects', 'follow_up_mode', 'TEXT NOT NULL', "'interrupt'");

      await exec(sql`
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

      await exec(sql`
        CREATE INDEX IF NOT EXISTS idx_message_queue_thread
        ON message_queue (thread_id, sort_order)
      `);
    },
  },

  {
    name: '018_thread_source',
    async up() {
      await addColumn('threads', 'source', 'TEXT NOT NULL', "'web'");
    },
  },

  {
    name: '019_parent_thread_id',
    async up() {
      await addColumn('threads', 'parent_thread_id', 'TEXT');
    },
  },

  {
    name: '020_project_defaults',
    async up() {
      await addColumn('projects', 'default_provider', 'TEXT');
      await addColumn('projects', 'default_model', 'TEXT');
      await addColumn('projects', 'default_mode', 'TEXT');
      await addColumn('projects', 'default_permission_mode', 'TEXT');
    },
  },

  {
    name: '021_thread_created_by',
    async up() {
      await addColumn('threads', 'created_by', 'TEXT');
    },
  },

  {
    name: '022_message_and_tool_call_author',
    async up() {
      await addColumn('messages', 'author', 'TEXT');
      await addColumn('tool_calls', 'author', 'TEXT');
    },
  },

  {
    name: '023_thread_events',
    async up() {
      await exec(sql`
        CREATE TABLE IF NOT EXISTS thread_events (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          event_type TEXT NOT NULL,
          payload TEXT NOT NULL,
          timestamp TEXT NOT NULL
        )
      `);

      await exec(sql`
        CREATE INDEX IF NOT EXISTS idx_thread_events_thread_timestamp
        ON thread_events (thread_id, timestamp)
      `);
    },
  },

  {
    name: '024_fix_thread_events_columns',
    async up() {
      try {
        await exec(sql`ALTER TABLE thread_events RENAME COLUMN payload TO data`);
      } catch {
        // Column may already be named 'data' on fresh installs
      }
      try {
        await exec(sql`ALTER TABLE thread_events RENAME COLUMN timestamp TO created_at`);
      } catch {
        // Column may already be named 'created_at' on fresh installs
      }
      await exec(sql`DROP INDEX IF EXISTS idx_thread_events_thread_timestamp`);
      await exec(sql`
        CREATE INDEX IF NOT EXISTS idx_thread_events_thread_created
        ON thread_events (thread_id, created_at)
      `);
    },
  },

  {
    name: '025_project_urls',
    async up() {
      await addColumn('projects', 'urls', 'TEXT');
    },
  },

  {
    name: '026_setup_completed',
    async up() {
      await addColumn('user_profiles', 'setup_completed', 'INTEGER NOT NULL', '0');
    },
  },

  {
    name: '027_user_settings',
    async up() {
      await addColumn('user_profiles', 'default_editor', 'TEXT');
      await addColumn('user_profiles', 'use_internal_editor', 'INTEGER');
      await addColumn('user_profiles', 'terminal_shell', 'TEXT');
      await addColumn('user_profiles', 'tool_permissions', 'TEXT');
      await addColumn('user_profiles', 'theme', 'TEXT');
    },
  },

  {
    name: '028_project_hooks',
    async up() {
      await exec(sql`
        CREATE TABLE IF NOT EXISTS project_hooks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          hook_type TEXT NOT NULL DEFAULT 'postCommit',
          label TEXT NOT NULL,
          command TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        )
      `);
    },
  },

  {
    name: '029_project_default_branch',
    async up() {
      await addColumn('projects', 'default_branch', 'TEXT');
    },
  },
  {
    name: '030_pipelines',
    async up() {
      await exec(sql`
        CREATE TABLE IF NOT EXISTS pipelines (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL DEFAULT '__local__',
          name TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          review_model TEXT NOT NULL DEFAULT 'sonnet',
          fix_model TEXT NOT NULL DEFAULT 'sonnet',
          max_iterations INTEGER NOT NULL DEFAULT 10,
          precommit_fix_enabled INTEGER NOT NULL DEFAULT 0,
          precommit_fix_model TEXT NOT NULL DEFAULT 'sonnet',
          precommit_fix_max_iterations INTEGER NOT NULL DEFAULT 3,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);

      await exec(sql`
        CREATE TABLE IF NOT EXISTS pipeline_runs (
          id TEXT PRIMARY KEY,
          pipeline_id TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'running',
          current_stage TEXT NOT NULL DEFAULT 'reviewer',
          iteration INTEGER NOT NULL DEFAULT 0,
          max_iterations INTEGER NOT NULL DEFAULT 10,
          commit_sha TEXT,
          verdict TEXT,
          findings TEXT,
          fixer_thread_id TEXT,
          precommit_iteration INTEGER,
          hook_name TEXT,
          hook_error TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT
        )
      `);

      await exec(sql`
        CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pipeline
        ON pipeline_runs (pipeline_id)
      `);
      await exec(sql`
        CREATE INDEX IF NOT EXISTS idx_pipeline_runs_thread
        ON pipeline_runs (thread_id)
      `);
    },
  },
  {
    name: '031_pipeline_reviewer_thread',
    async up() {
      await addColumn('pipeline_runs', 'reviewer_thread_id', 'TEXT');
    },
  },
  {
    name: '032_project_system_prompt',
    async up() {
      await addColumn('projects', 'system_prompt', 'TEXT');
    },
  },
  {
    name: '033_pipeline_custom_prompts',
    async up() {
      await addColumn('pipelines', 'reviewer_prompt', 'TEXT');
      await addColumn('pipelines', 'corrector_prompt', 'TEXT');
      await addColumn('pipelines', 'precommit_fixer_prompt', 'TEXT');
      await addColumn('pipelines', 'commit_message_prompt', 'TEXT');
    },
  },
  {
    name: '034_podman_remote_runtime',
    async up() {
      await addColumn('projects', 'launcher_url', 'TEXT');
      await addColumn('threads', 'runtime', 'TEXT NOT NULL', "'local'");
      await addColumn('threads', 'container_url', 'TEXT');
      await addColumn('threads', 'container_name', 'TEXT');
    },
  },
  {
    name: '035_team_projects',
    async up() {
      await exec(sql`
        CREATE TABLE IF NOT EXISTS team_projects (
          team_id TEXT NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          PRIMARY KEY (team_id, project_id)
        )
      `);

      await exec(sql`
        CREATE INDEX IF NOT EXISTS idx_team_projects_team
        ON team_projects (team_id)
      `);
      await exec(sql`
        CREATE INDEX IF NOT EXISTS idx_team_projects_project
        ON team_projects (project_id)
      `);
    },
  },

  {
    name: '036_instance_settings',
    async up() {
      await exec(sql`
        CREATE TABLE IF NOT EXISTS instance_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
    },
  },

  {
    name: '037_pty_sessions',
    async up() {
      await exec(sql`
        CREATE TABLE IF NOT EXISTS pty_sessions (
          id TEXT PRIMARY KEY,
          tmux_session TEXT NOT NULL UNIQUE,
          user_id TEXT NOT NULL DEFAULT '__local__',
          cwd TEXT NOT NULL,
          shell TEXT,
          cols INTEGER NOT NULL DEFAULT 80,
          rows INTEGER NOT NULL DEFAULT 24,
          created_at TEXT NOT NULL
        )
      `);
    },
  },
  {
    name: '038_pty_sessions_metadata',
    async up() {
      await addColumn('pty_sessions', 'project_id', 'TEXT');
      await addColumn('pty_sessions', 'label', 'TEXT');
    },
  },
  {
    name: '039_pty_sessions_terminal_state',
    async up() {
      await addColumn('pty_sessions', 'terminal_state', 'TEXT');
    },
  },
  {
    name: '040_pipeline_test_autofix',
    async up() {
      await addColumn('pipelines', 'test_enabled', 'INTEGER NOT NULL', '0');
      await addColumn('pipelines', 'test_command', 'TEXT');
      await addColumn('pipelines', 'test_fix_enabled', 'INTEGER NOT NULL', '0');
      await addColumn('pipelines', 'test_fix_model', 'TEXT NOT NULL', "'sonnet'");
      await addColumn('pipelines', 'test_fix_max_iterations', 'INTEGER NOT NULL', '3');
      await addColumn('pipelines', 'test_fixer_prompt', 'TEXT');
    },
  },
  {
    name: '041_runners',
    async up() {
      await exec(sql`
        CREATE TABLE IF NOT EXISTS runners (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          hostname TEXT NOT NULL,
          token TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'offline',
          project_paths TEXT NOT NULL DEFAULT '[]',
          active_thread_ids TEXT NOT NULL DEFAULT '[]',
          registered_at TEXT NOT NULL,
          last_heartbeat_at TEXT NOT NULL
        )
      `);

      await exec(sql`
        CREATE TABLE IF NOT EXISTS runner_tasks (
          id TEXT PRIMARY KEY,
          runner_id TEXT NOT NULL REFERENCES runners(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          result_data TEXT,
          result_error TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT
        )
      `);

      await exec(sql`
        CREATE INDEX IF NOT EXISTS idx_runner_tasks_runner_status
        ON runner_tasks (runner_id, status)
      `);
    },
  },
  {
    name: '042_runner_project_assignments',
    async up() {
      // Replace project_paths with os + workspace on runners table
      await addColumn('runners', 'os', 'TEXT NOT NULL', "'unknown'");
      await addColumn('runners', 'workspace', 'TEXT');

      // Create assignment table: admin assigns projects to runners with local paths
      await exec(sql`
        CREATE TABLE IF NOT EXISTS runner_project_assignments (
          runner_id TEXT NOT NULL REFERENCES runners(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          local_path TEXT NOT NULL,
          assigned_at TEXT NOT NULL,
          PRIMARY KEY (runner_id, project_id)
        )
      `);

      await exec(sql`
        CREATE INDEX IF NOT EXISTS idx_runner_assignments_project
        ON runner_project_assignments (project_id)
      `);
    },
  },
  {
    name: '043_assemblyai_api_key',
    async up() {
      await addColumn('user_profiles', 'assemblyai_api_key', 'TEXT');
    },
  },
  {
    // invite_links moved to packages/server (central server only).
    // Migration kept as no-op so existing databases don't re-run it.
    name: '044_invite_links',
    async up() {},
  },
];

// ── Public API ──────────────────────────────────────────────────

/**
 * Run all pending migrations in order.
 * Each migration runs exactly once, tracked by the _migrations table.
 * Existing databases (pre-migration-tracking) are handled gracefully
 * because each migration uses CREATE TABLE IF NOT EXISTS / addColumn.
 */
export async function autoMigrate() {
  await ensureMigrationTable();

  let applied = 0;
  for (const migration of migrations) {
    if (await hasRun(migration.name)) continue;

    try {
      await migration.up();
      await markRun(migration.name);
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
