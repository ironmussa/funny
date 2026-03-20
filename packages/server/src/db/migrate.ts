/**
 * Central server migrations — dialect-agnostic.
 *
 * Uses the shared migration infrastructure from @funny/shared.
 * Each package defines its own migrations array and calls `runMigrations()`.
 *
 * The raw SQL uses TEXT/INTEGER/REAL types which work identically in both
 * SQLite and PostgreSQL. Dialect-specific features (FTS5, tsvector) are
 * guarded by `ctx().dialect` checks.
 */

import {
  type Migration,
  createMigrationContext,
  runMigrations,
  sql,
} from '@funny/shared/db/migrate';

import { log } from '../lib/logger.js';
import { db, dbDialect } from './index.js';

// Lazily create context — db may not be ready at import time
let _ctx: ReturnType<typeof createMigrationContext> | null = null;
function ctx() {
  if (!_ctx) _ctx = createMigrationContext(db, dbDialect);
  return _ctx;
}

const migrations: Migration[] = [
  {
    name: '001_projects',
    async up() {
      await ctx().exec(sql`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          path TEXT NOT NULL DEFAULT '',
          color TEXT,
          follow_up_mode TEXT NOT NULL DEFAULT 'interrupt',
          default_provider TEXT,
          default_model TEXT,
          default_mode TEXT,
          default_permission_mode TEXT,
          default_branch TEXT,
          urls TEXT,
          system_prompt TEXT,
          launcher_url TEXT,
          user_id TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        )
      `);

      await ctx().exec(sql`
        CREATE TABLE IF NOT EXISTS project_members (
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'member',
          local_path TEXT,
          joined_at TEXT NOT NULL,
          PRIMARY KEY (project_id, user_id)
        )
      `);

      await ctx().exec(sql`
        CREATE INDEX IF NOT EXISTS idx_project_members_user
        ON project_members (user_id)
      `);
    },
  },
  {
    name: '002_runners',
    async up() {
      await ctx().exec(sql`
        CREATE TABLE IF NOT EXISTS runners (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          hostname TEXT NOT NULL,
          user_id TEXT,
          token TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'offline',
          os TEXT NOT NULL DEFAULT 'unknown',
          workspace TEXT,
          http_url TEXT,
          active_thread_ids TEXT NOT NULL DEFAULT '[]',
          registered_at TEXT NOT NULL,
          last_heartbeat_at TEXT NOT NULL
        )
      `);

      await ctx().exec(sql`
        CREATE TABLE IF NOT EXISTS runner_project_assignments (
          runner_id TEXT NOT NULL REFERENCES runners(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          local_path TEXT NOT NULL,
          assigned_at TEXT NOT NULL,
          PRIMARY KEY (runner_id, project_id)
        )
      `);

      await ctx().exec(sql`
        CREATE INDEX IF NOT EXISTS idx_runner_assignments_project
        ON runner_project_assignments (project_id)
      `);

      await ctx().exec(sql`
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

      await ctx().exec(sql`
        CREATE INDEX IF NOT EXISTS idx_runner_tasks_runner_status
        ON runner_tasks (runner_id, status)
      `);
    },
  },
  {
    name: '003_user_profiles',
    async up() {
      await ctx().exec(sql`
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
    name: '004_instance_settings',
    async up() {
      await ctx().exec(sql`
        CREATE TABLE IF NOT EXISTS instance_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
    },
  },
  {
    name: '005_runner_http_url',
    async up() {
      await ctx().addColumn('runners', 'http_url', 'TEXT');
    },
  },
  {
    name: '006_threads',
    async up() {
      await ctx().exec(sql`
        CREATE TABLE IF NOT EXISTS threads (
          id TEXT PRIMARY KEY,
          project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
          runner_id TEXT REFERENCES runners(id) ON DELETE SET NULL,
          user_id TEXT NOT NULL,
          title TEXT,
          status TEXT NOT NULL DEFAULT 'idle',
          stage TEXT NOT NULL DEFAULT 'backlog',
          model TEXT,
          mode TEXT,
          branch TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT
        )
      `);

      // Add runner_id if the table already existed without it
      await ctx().addColumn('threads', 'runner_id', 'TEXT');

      await ctx().exec(sql`
        CREATE INDEX IF NOT EXISTS idx_threads_project
        ON threads (project_id)
      `);

      await ctx().exec(sql`
        CREATE INDEX IF NOT EXISTS idx_threads_runner
        ON threads (runner_id)
      `);

      await ctx().exec(sql`
        CREATE INDEX IF NOT EXISTS idx_threads_user
        ON threads (user_id)
      `);
    },
  },
  {
    name: '007_runners_user_id',
    async up() {
      // The runners table may have been created by the runtime package (migration 041_runners)
      // with a different schema (project_paths instead of user_id). Ensure user_id exists.
      await ctx().addColumn('runners', 'user_id', 'TEXT');
    },
  },
  {
    name: '008_invite_links',
    async up() {
      await ctx().exec(sql`
        CREATE TABLE IF NOT EXISTS invite_links (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL,
          token TEXT NOT NULL UNIQUE,
          role TEXT NOT NULL DEFAULT 'member',
          created_by TEXT NOT NULL,
          expires_at TEXT,
          max_uses TEXT,
          use_count TEXT NOT NULL DEFAULT '0',
          revoked TEXT NOT NULL DEFAULT '0',
          created_at TEXT NOT NULL
        )
      `);

      await ctx().exec(sql`
        CREATE INDEX IF NOT EXISTS idx_invite_links_token
        ON invite_links (token)
      `);

      await ctx().exec(sql`
        CREATE INDEX IF NOT EXISTS idx_invite_links_org
        ON invite_links (organization_id)
      `);
    },
  },

  // ── Migrations to match runtime tables ──────────────────────────

  {
    name: '009_messages',
    async up() {
      await ctx().exec(sql`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          images TEXT,
          model TEXT,
          permission_mode TEXT,
          author TEXT
        )
      `);

      await ctx().exec(sql`
        CREATE INDEX IF NOT EXISTS idx_messages_thread_timestamp
        ON messages (thread_id, timestamp)
      `);
    },
  },

  {
    name: '010_messages_search_vector',
    async up() {
      if (ctx().dialect === 'pg') {
        // PostgreSQL: add tsvector column + GIN index for full-text search
        await ctx().exec(
          sql.raw(`
          ALTER TABLE messages ADD COLUMN IF NOT EXISTS search_vector tsvector
            GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
        `),
        );
        await ctx().exec(
          sql.raw(`
          CREATE INDEX IF NOT EXISTS idx_messages_search_vector
          ON messages USING gin(search_vector)
        `),
        );
      }
      // SQLite: FTS5 is handled by the runtime's migration 016_fts5_search
    },
  },

  {
    name: '011_tool_calls',
    async up() {
      await ctx().exec(sql`
        CREATE TABLE IF NOT EXISTS tool_calls (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          input TEXT,
          output TEXT,
          author TEXT
        )
      `);
    },
  },

  {
    name: '012_startup_commands',
    async up() {
      await ctx().exec(sql`
        CREATE TABLE IF NOT EXISTS startup_commands (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          label TEXT NOT NULL,
          command TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          port INTEGER,
          port_env_var TEXT,
          created_at TEXT NOT NULL
        )
      `);
    },
  },

  {
    name: '013_automations',
    async up() {
      await ctx().exec(sql`
        CREATE TABLE IF NOT EXISTS automations (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          prompt TEXT NOT NULL,
          schedule TEXT NOT NULL,
          model TEXT NOT NULL DEFAULT 'sonnet',
          mode TEXT NOT NULL DEFAULT 'worktree',
          permission_mode TEXT NOT NULL DEFAULT 'autoEdit',
          provider TEXT NOT NULL DEFAULT 'claude',
          base_branch TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          max_run_history INTEGER NOT NULL DEFAULT 20,
          last_run_at TEXT,
          next_run_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);

      await ctx().exec(sql`
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
    name: '014_mcp_oauth_tokens',
    async up() {
      await ctx().exec(sql`
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
    name: '015_thread_comments',
    async up() {
      await ctx().exec(sql`
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
    name: '016_message_queue',
    async up() {
      await ctx().exec(sql`
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

      await ctx().exec(sql`
        CREATE INDEX IF NOT EXISTS idx_message_queue_thread
        ON message_queue (thread_id, sort_order)
      `);
    },
  },

  {
    name: '017_stage_history',
    async up() {
      await ctx().exec(sql`
        CREATE TABLE IF NOT EXISTS stage_history (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          from_stage TEXT,
          to_stage TEXT NOT NULL,
          changed_at TEXT NOT NULL
        )
      `);
    },
  },

  {
    name: '018_pipelines',
    async up() {
      await ctx().exec(sql`
        CREATE TABLE IF NOT EXISTS pipelines (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          review_model TEXT NOT NULL DEFAULT 'sonnet',
          fix_model TEXT NOT NULL DEFAULT 'sonnet',
          max_iterations INTEGER NOT NULL DEFAULT 10,
          precommit_fix_enabled INTEGER NOT NULL DEFAULT 0,
          precommit_fix_model TEXT NOT NULL DEFAULT 'sonnet',
          precommit_fix_max_iterations INTEGER NOT NULL DEFAULT 3,
          reviewer_prompt TEXT,
          corrector_prompt TEXT,
          precommit_fixer_prompt TEXT,
          commit_message_prompt TEXT,
          test_enabled INTEGER NOT NULL DEFAULT 0,
          test_command TEXT,
          test_fix_enabled INTEGER NOT NULL DEFAULT 0,
          test_fix_model TEXT NOT NULL DEFAULT 'sonnet',
          test_fix_max_iterations INTEGER NOT NULL DEFAULT 3,
          test_fixer_prompt TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);

      await ctx().exec(sql`
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
          reviewer_thread_id TEXT,
          precommit_iteration INTEGER,
          hook_name TEXT,
          hook_error TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT
        )
      `);

      await ctx().exec(sql`
        CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pipeline
        ON pipeline_runs (pipeline_id)
      `);
      await ctx().exec(sql`
        CREATE INDEX IF NOT EXISTS idx_pipeline_runs_thread
        ON pipeline_runs (thread_id)
      `);
    },
  },

  {
    name: '019_team_projects',
    async up() {
      await ctx().exec(sql`
        CREATE TABLE IF NOT EXISTS team_projects (
          team_id TEXT NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          PRIMARY KEY (team_id, project_id)
        )
      `);

      await ctx().exec(sql`
        CREATE INDEX IF NOT EXISTS idx_team_projects_team ON team_projects (team_id)
      `);
      await ctx().exec(sql`
        CREATE INDEX IF NOT EXISTS idx_team_projects_project ON team_projects (project_id)
      `);
    },
  },

  {
    name: '020_thread_events',
    async up() {
      await ctx().exec(sql`
        CREATE TABLE IF NOT EXISTS thread_events (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          event_type TEXT NOT NULL,
          data TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);

      await ctx().exec(sql`
        CREATE INDEX IF NOT EXISTS idx_thread_events_thread_created
        ON thread_events (thread_id, created_at)
      `);
    },
  },

  {
    name: '021_pty_sessions',
    async up() {
      await ctx().exec(sql`
        CREATE TABLE IF NOT EXISTS pty_sessions (
          id TEXT PRIMARY KEY,
          tmux_session TEXT NOT NULL UNIQUE,
          user_id TEXT NOT NULL,
          cwd TEXT NOT NULL,
          shell TEXT,
          cols INTEGER NOT NULL DEFAULT 80,
          rows INTEGER NOT NULL DEFAULT 24,
          project_id TEXT,
          label TEXT,
          terminal_state TEXT,
          created_at TEXT NOT NULL
        )
      `);
    },
  },

  {
    name: '022_project_hooks',
    async up() {
      await ctx().exec(sql`
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

  // ── Add missing columns to existing server tables ───────────────

  {
    name: '023_threads_missing_columns',
    async up() {
      await ctx().addColumn('threads', 'archived', 'INTEGER NOT NULL', '0');
      await ctx().addColumn('threads', 'permission_mode', 'TEXT NOT NULL', "'autoEdit'");
      await ctx().addColumn('threads', 'base_branch', 'TEXT');
      await ctx().addColumn('threads', 'automation_id', 'TEXT');
      await ctx().addColumn('threads', 'pinned', 'INTEGER NOT NULL', '0');
      await ctx().addColumn('threads', 'initial_prompt', 'TEXT');
      await ctx().addColumn('threads', 'provider', 'TEXT NOT NULL', "'claude'");
      await ctx().addColumn('threads', 'external_request_id', 'TEXT');
      await ctx().addColumn('threads', 'init_tools', 'TEXT');
      await ctx().addColumn('threads', 'init_cwd', 'TEXT');
      await ctx().addColumn('threads', 'source', 'TEXT NOT NULL', "'web'");
      await ctx().addColumn('threads', 'parent_thread_id', 'TEXT');
      await ctx().addColumn('threads', 'created_by', 'TEXT');
      await ctx().addColumn('threads', 'runtime', 'TEXT NOT NULL', "'local'");
      await ctx().addColumn('threads', 'container_url', 'TEXT');
      await ctx().addColumn('threads', 'container_name', 'TEXT');
      await ctx().addColumn('threads', 'worktree_path', 'TEXT');
      await ctx().addColumn('threads', 'session_id', 'TEXT');
      await ctx().addColumn('threads', 'cost', 'REAL NOT NULL', '0');
    },
  },

  {
    name: '024_projects_missing_columns',
    async up() {
      await ctx().addColumn('projects', 'path', 'TEXT');
      await ctx().addColumn('projects', 'user_id', 'TEXT NOT NULL', "''");
      await ctx().addColumn('projects', 'sort_order', 'INTEGER NOT NULL', '0');
      await ctx().addColumn('projects', 'color', 'TEXT');
      await ctx().addColumn('projects', 'follow_up_mode', 'TEXT NOT NULL', "'interrupt'");
      await ctx().addColumn('projects', 'default_provider', 'TEXT');
      await ctx().addColumn('projects', 'default_model', 'TEXT');
      await ctx().addColumn('projects', 'default_mode', 'TEXT');
      await ctx().addColumn('projects', 'default_permission_mode', 'TEXT');
      await ctx().addColumn('projects', 'urls', 'TEXT');
      await ctx().addColumn('projects', 'default_branch', 'TEXT');
      await ctx().addColumn('projects', 'system_prompt', 'TEXT');
      await ctx().addColumn('projects', 'launcher_url', 'TEXT');
    },
  },

  {
    name: '025_user_profiles_missing_columns',
    async up() {
      await ctx().addColumn('user_profiles', 'setup_completed', 'INTEGER NOT NULL', '0');
      await ctx().addColumn('user_profiles', 'default_editor', 'TEXT');
      await ctx().addColumn('user_profiles', 'use_internal_editor', 'INTEGER');
      await ctx().addColumn('user_profiles', 'terminal_shell', 'TEXT');
      await ctx().addColumn('user_profiles', 'tool_permissions', 'TEXT');
      await ctx().addColumn('user_profiles', 'theme', 'TEXT');
      await ctx().addColumn('user_profiles', 'assemblyai_api_key', 'TEXT');
    },
  },

  {
    name: '026_runner_invite_token',
    async up() {
      await ctx().addColumn('user_profiles', 'runner_invite_token', 'TEXT');
    },
  },

  {
    // Better Auth tables for SQLite.
    name: '027_better_auth_tables',
    async up() {
      await ctx().exec(sql`
        CREATE TABLE IF NOT EXISTS "user" (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE,
          email_verified INTEGER NOT NULL DEFAULT 0,
          image TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          username TEXT UNIQUE,
          role TEXT,
          banned INTEGER,
          ban_reason TEXT,
          ban_expires TEXT
        )
      `);

      await ctx().exec(sql`
        CREATE TABLE IF NOT EXISTS session (
          id TEXT PRIMARY KEY,
          expires_at TEXT NOT NULL,
          token TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          ip_address TEXT,
          user_agent TEXT,
          user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
        )
      `);

      await ctx().exec(sql`
        CREATE TABLE IF NOT EXISTS account (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
          access_token TEXT,
          refresh_token TEXT,
          id_token TEXT,
          access_token_expires_at TEXT,
          refresh_token_expires_at TEXT,
          scope TEXT,
          password TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);

      await ctx().exec(sql`
        CREATE TABLE IF NOT EXISTS verification (
          id TEXT PRIMARY KEY,
          identifier TEXT NOT NULL,
          value TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT,
          updated_at TEXT
        )
      `);

      await ctx().exec(sql`
        CREATE TABLE IF NOT EXISTS organization (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT UNIQUE,
          logo TEXT,
          created_at TEXT NOT NULL,
          metadata TEXT
        )
      `);

      await ctx().exec(sql`
        CREATE TABLE IF NOT EXISTS member (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);

      await ctx().exec(sql`
        CREATE TABLE IF NOT EXISTS invitation (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
          email TEXT NOT NULL,
          role TEXT,
          status TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          inviter_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
        )
      `);
    },
  },

  {
    name: '028_threads_merged_at',
    async up() {
      await ctx().addColumn('threads', 'merged_at', 'TEXT');
    },
  },

  {
    name: '029_arcs',
    async up() {
      await ctx().exec(sql`
        CREATE TABLE IF NOT EXISTS arcs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);

      await ctx().exec(sql`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_arcs_project_name
        ON arcs (project_id, user_id, name)
      `);

      await ctx().addColumn('threads', 'arc_id', 'TEXT');
      await ctx().addColumn('threads', 'purpose', 'TEXT NOT NULL', "'implement'");
    },
  },

  {
    name: '030_tool_call_parent',
    async up() {
      await ctx().addColumn('tool_calls', 'parent_tool_call_id', 'TEXT');
    },
  },
  {
    name: '031_backfill_runner_user_id',
    async up() {
      // Backfill null user_id on runners with the first admin user.
      // Also deduplicate: keep only the most recently registered runner per hostname.
      const c = ctx();

      // 1. Backfill user_id from first admin user
      await c.exec(sql`
        UPDATE runners SET user_id = (
          SELECT id FROM "user" WHERE role = 'admin' LIMIT 1
        )
        WHERE user_id IS NULL
      `);

      // 2. Deduplicate: delete all but the newest runner per hostname
      // Also clean up their project assignments first
      await c.exec(sql`
        DELETE FROM runner_project_assignments WHERE runner_id NOT IN (
          SELECT id FROM runners r1
          WHERE registered_at = (
            SELECT MAX(registered_at) FROM runners r2 WHERE r2.hostname = r1.hostname
          )
        )
      `);
      await c.exec(sql`
        DELETE FROM runners WHERE id NOT IN (
          SELECT id FROM runners r1
          WHERE registered_at = (
            SELECT MAX(registered_at) FROM runners r2 WHERE r2.hostname = r1.hostname
          )
        )
      `);
    },
  },
  {
    name: '032_provider_keys',
    async up() {
      await ctx().addColumn('user_profiles', 'provider_keys', 'TEXT');
    },
  },
];

export async function autoMigrate() {
  await runMigrations(db as any, migrations, log, 'central-db', dbDialect);
}
