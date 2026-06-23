/**
 * In-memory SQLite database for shared repository tests.
 * Mirrors the runtime test-db helper but lives within the shared package.
 */
import { Database } from 'bun:sqlite';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';

import { dbAll, dbGet, dbRun } from '../../db/connection.js';
import * as schema from '../../db/schema.sqlite.js';

export function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');

  const testDb = drizzle(sqlite, { schema });

  testDb.run(sql`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      color TEXT,
      follow_up_mode TEXT NOT NULL DEFAULT 'interrupt',
      fast_mode INTEGER NOT NULL DEFAULT 0,
      default_provider TEXT,
      default_model TEXT,
      default_mode TEXT,
      default_permission_mode TEXT,
      default_branch TEXT,
      urls TEXT,
      system_prompt TEXT,
      launcher_url TEXT,
      user_id TEXT NOT NULL DEFAULT '',
      organization_id TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      memory_enabled INTEGER NOT NULL DEFAULT 0,
      default_agent_template_id TEXT,
      closed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);

  testDb.run(sql`
    CREATE TABLE IF NOT EXISTS resource_grants (
      subject_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      role TEXT NOT NULL,
      granted_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (subject_id, resource_type, resource_id)
    )
  `);

  testDb.run(sql`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL DEFAULT '',
      is_scratch INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      title TEXT NOT NULL,
      mode TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'claude',
      permission_mode TEXT NOT NULL DEFAULT 'autoEdit',
      status TEXT NOT NULL DEFAULT 'pending',
      branch TEXT,
      base_branch TEXT,
      worktree_path TEXT,
      session_id TEXT,
      cost REAL NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      stage TEXT NOT NULL DEFAULT 'backlog',
      model TEXT NOT NULL DEFAULT 'sonnet',
      initial_prompt TEXT,
      source TEXT NOT NULL DEFAULT 'web',
      external_request_id TEXT,
      parent_thread_id TEXT,
      design_id TEXT,
      agent_template_id TEXT,
      template_variables TEXT,
      file_checkpointing_enabled INTEGER NOT NULL DEFAULT 0,
      orchestrator_managed INTEGER NOT NULL DEFAULT 0,
      runtime TEXT NOT NULL DEFAULT 'local',
      container_url TEXT,
      container_name TEXT,
      init_tools TEXT,
      init_cwd TEXT,
      init_slash_commands TEXT,
      runner_id TEXT,
      merged_at TEXT,
      context_recovery_reason TEXT,
      agent_profile_id TEXT,
      agent_profile_name TEXT,
      agent_profile_provider TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )
  `);

  testDb.run(sql`
    CREATE TABLE IF NOT EXISTS agent_execution_profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      config TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  testDb.run(sql`
    CREATE TABLE IF NOT EXISTS project_agent_profile_bindings (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      profile_id TEXT NOT NULL REFERENCES agent_execution_profiles(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, user_id)
    )
  `);

  testDb.run(sql`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      images TEXT,
      model TEXT,
      permission_mode TEXT,
      effort TEXT,
      author TEXT,
      timestamp TEXT NOT NULL
    )
  `);

  testDb.run(sql`
    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      input TEXT,
      output TEXT,
      author TEXT,
      parent_tool_call_id TEXT
    )
  `);

  testDb.run(sql`
    CREATE TABLE IF NOT EXISTS stage_history (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      from_stage TEXT,
      to_stage TEXT NOT NULL,
      changed_at TEXT NOT NULL
    )
  `);

  testDb.run(sql`
    CREATE TABLE IF NOT EXISTS thread_comments (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'user',
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  testDb.run(sql`
    CREATE TABLE IF NOT EXISTS thread_shares (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      shared_with_user_id TEXT NOT NULL,
      shared_by_user_id TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'view',
      created_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, shared_with_user_id)
    )
  `);

  testDb.run(sql`
    CREATE TABLE IF NOT EXISTS team_projects (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      project_id TEXT NOT NULL
    )
  `);

  testDb.run(sql`
    CREATE TABLE IF NOT EXISTS orchestrator_runs (
      thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
      pipeline_run_id TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      next_retry_at_ms INTEGER,
      last_event_at_ms INTEGER NOT NULL,
      last_error TEXT,
      claimed_at_ms INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      tokens_total INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL
    )
  `);

  testDb.run(sql`
    CREATE TABLE IF NOT EXISTS thread_dependencies (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      blocked_by TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      PRIMARY KEY (thread_id, blocked_by)
    )
  `);

  testDb.run(sql`
    CREATE TABLE IF NOT EXISTS watchers (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      label TEXT NOT NULL,
      next_wake_at INTEGER NOT NULL,
      last_delay_ms INTEGER NOT NULL DEFAULT 0,
      wake_count INTEGER NOT NULL DEFAULT 0,
      max_wakes INTEGER NOT NULL DEFAULT 20,
      deadline INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  testDb.run(sql`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      command TEXT NOT NULL,
      cwd TEXT,
      label TEXT,
      pid INTEGER,
      log_path TEXT NOT NULL,
      exit_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      exit_code INTEGER,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  return { db: testDb as any, sqlite, schema, dbAll, dbGet, dbRun };
}

export function seedProject(db: any, overrides: Partial<typeof schema.projects.$inferInsert> = {}) {
  const project = {
    id: overrides.id ?? 'p1',
    name: overrides.name ?? 'Test Project',
    path: overrides.path ?? '/tmp/test-repo',
    userId: overrides.userId ?? 'user-1',
    organizationId: overrides.organizationId ?? null,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
  db.insert(schema.projects).values(project).run();
  return project;
}

export function seedThread(db: any, overrides: Partial<typeof schema.threads.$inferInsert> = {}) {
  const thread = {
    id: 't1',
    projectId: 'p1',
    userId: 'user-1',
    title: 'Test Thread',
    mode: 'local',
    status: 'pending',
    stage: 'backlog',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
  db.insert(schema.threads).values(thread).run();
  return thread;
}

export function seedMessage(db: any, overrides: Partial<typeof schema.messages.$inferInsert> = {}) {
  const message = {
    id: overrides.id ?? 'm1',
    threadId: overrides.threadId ?? 't1',
    role: overrides.role ?? 'user',
    content: overrides.content ?? 'Hello world',
    timestamp: overrides.timestamp ?? new Date().toISOString(),
  };
  db.insert(schema.messages).values(message).run();
  return message;
}

export function seedToolCall(
  db: any,
  overrides: Partial<typeof schema.toolCalls.$inferInsert> = {},
) {
  const toolCall = {
    id: overrides.id ?? 'tc1',
    messageId: overrides.messageId ?? 'm1',
    name: overrides.name ?? 'Read',
    input: overrides.input ?? '{"file":"test.ts"}',
    output: overrides.output ?? null,
  };
  db.insert(schema.toolCalls).values(toolCall).run();
  return toolCall;
}
