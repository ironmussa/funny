/**
 * Central server migrations (PostgreSQL).
 */

import { sql } from 'drizzle-orm';

import { log } from '../lib/logger.js';
import { db } from './index.js';

async function exec(query: ReturnType<typeof sql> | ReturnType<typeof sql.raw>): Promise<void> {
  await (db as any).execute(query);
}

async function queryOne<T>(
  query: ReturnType<typeof sql> | ReturnType<typeof sql.raw>,
): Promise<T | undefined> {
  const rows = await (db as any).execute(query);
  return rows?.[0] as T | undefined;
}

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

const migrations: Migration[] = [
  {
    name: '001_projects',
    async up() {
      await exec(sql`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          repo_url TEXT NOT NULL,
          description TEXT,
          created_by TEXT NOT NULL,
          organization_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);

      await exec(sql`
        CREATE TABLE IF NOT EXISTS project_members (
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'member',
          local_path TEXT,
          joined_at TEXT NOT NULL,
          PRIMARY KEY (project_id, user_id)
        )
      `);

      await exec(sql`
        CREATE INDEX IF NOT EXISTS idx_project_members_user
        ON project_members (user_id)
      `);
    },
  },
  {
    name: '002_runners',
    async up() {
      await exec(sql`
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
    name: '003_user_profiles',
    async up() {
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
    name: '004_instance_settings',
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
    name: '005_runner_http_url',
    async up() {
      await exec(sql`
        ALTER TABLE runners ADD COLUMN IF NOT EXISTS http_url TEXT
      `);
    },
  },
  {
    name: '006_threads',
    async up() {
      await exec(sql`
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
      await exec(sql`
        ALTER TABLE threads ADD COLUMN IF NOT EXISTS runner_id TEXT REFERENCES runners(id) ON DELETE SET NULL
      `);

      await exec(sql`
        CREATE INDEX IF NOT EXISTS idx_threads_project
        ON threads (project_id)
      `);

      await exec(sql`
        CREATE INDEX IF NOT EXISTS idx_threads_runner
        ON threads (runner_id)
      `);

      await exec(sql`
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
      await exec(sql`
        ALTER TABLE runners ADD COLUMN IF NOT EXISTS user_id TEXT
      `);
    },
  },
  {
    name: '008_invite_links',
    async up() {
      await exec(sql`
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

      await exec(sql`
        CREATE INDEX IF NOT EXISTS idx_invite_links_token
        ON invite_links (token)
      `);

      await exec(sql`
        CREATE INDEX IF NOT EXISTS idx_invite_links_org
        ON invite_links (organization_id)
      `);
    },
  },
];

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
      log.error(`Migration ${migration.name} failed`, { namespace: 'db', error: err as any });
      throw err;
    }
  }

  if (applied > 0) {
    log.info(`Applied ${applied} migration(s)`, { namespace: 'db' });
  }

  log.info('Central DB tables ready', { namespace: 'db' });
}
