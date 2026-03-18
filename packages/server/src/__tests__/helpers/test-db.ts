/**
 * In-memory SQLite database for server package tests.
 * Creates a fresh DB with the full schema for each test suite.
 */
import { Database } from 'bun:sqlite';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';

import * as schema from '../../db/schema.js';

export function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');

  const testDb = drizzle(sqlite, { schema });

  // ── Shared tables ──────────────────────────────────────────

  testDb.run(sql`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
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
      user_id TEXT NOT NULL DEFAULT '__local__',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);

  testDb.run(sql`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL DEFAULT '__local__',
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
      model TEXT NOT NULL DEFAULT 'opus',
      initial_prompt TEXT,
      source TEXT NOT NULL DEFAULT 'web',
      external_request_id TEXT,
      parent_thread_id TEXT,
      arc_id TEXT,
      purpose TEXT NOT NULL DEFAULT 'implement',
      runtime TEXT NOT NULL DEFAULT 'local',
      container_url TEXT,
      container_name TEXT,
      init_tools TEXT,
      init_cwd TEXT,
      runner_id TEXT,
      merged_at TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
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
      author TEXT
    )
  `);

  testDb.run(sql`
    CREATE TABLE IF NOT EXISTS pipelines (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL DEFAULT '__local__',
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      review_model TEXT NOT NULL DEFAULT 'opus',
      fix_model TEXT NOT NULL DEFAULT 'opus',
      max_iterations INTEGER NOT NULL DEFAULT 10,
      precommit_fix_enabled INTEGER NOT NULL DEFAULT 0,
      precommit_fix_model TEXT NOT NULL DEFAULT 'opus',
      precommit_fix_max_iterations INTEGER NOT NULL DEFAULT 3,
      reviewer_prompt TEXT,
      corrector_prompt TEXT,
      precommit_fixer_prompt TEXT,
      commit_message_prompt TEXT,
      test_enabled INTEGER NOT NULL DEFAULT 0,
      test_command TEXT,
      test_fix_enabled INTEGER NOT NULL DEFAULT 0,
      test_fix_model TEXT NOT NULL DEFAULT 'opus',
      test_fix_max_iterations INTEGER NOT NULL DEFAULT 3,
      test_fixer_prompt TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  testDb.run(sql`
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
      reviewer_thread_id TEXT,
      fixer_thread_id TEXT,
      precommit_iteration INTEGER,
      hook_name TEXT,
      hook_error TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )
  `);

  testDb.run(sql`
    CREATE TABLE IF NOT EXISTS thread_events (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  testDb.run(sql`
    CREATE TABLE IF NOT EXISTS user_profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      git_name TEXT,
      git_email TEXT,
      github_token TEXT,
      assemblyai_api_key TEXT,
      runner_invite_token TEXT,
      setup_completed INTEGER NOT NULL DEFAULT 0,
      default_editor TEXT,
      use_internal_editor INTEGER,
      terminal_shell TEXT,
      tool_permissions TEXT,
      theme TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  testDb.run(sql`
    CREATE TABLE IF NOT EXISTS team_projects (
      team_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (team_id, project_id)
    )
  `);

  testDb.run(sql`
    CREATE TABLE IF NOT EXISTS instance_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // ── Server-only tables ─────────────────────────────────────

  testDb.run(sql`
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

  testDb.run(sql`
    CREATE TABLE IF NOT EXISTS runner_project_assignments (
      runner_id TEXT NOT NULL REFERENCES runners(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      local_path TEXT NOT NULL,
      assigned_at TEXT NOT NULL,
      PRIMARY KEY (runner_id, project_id)
    )
  `);

  testDb.run(sql`
    CREATE TABLE IF NOT EXISTS project_members (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      local_path TEXT,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (project_id, user_id)
    )
  `);

  return { db: testDb, sqlite, schema };
}

// ── Seed helpers ────────────────────────────────────────────

export function seedProject(
  db: ReturnType<typeof createTestDb>['db'],
  overrides: Partial<typeof schema.projects.$inferInsert> = {},
) {
  const project = {
    id: overrides.id ?? 'test-project-1',
    name: overrides.name ?? 'Test Project',
    path: overrides.path ?? '/tmp/test-repo',
    userId: overrides.userId ?? '__local__',
    sortOrder: overrides.sortOrder ?? 0,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
  db.insert(schema.projects).values(project).run();
  return project;
}

export function seedThread(
  db: ReturnType<typeof createTestDb>['db'],
  overrides: Partial<typeof schema.threads.$inferInsert> = {},
) {
  const thread = {
    id: overrides.id ?? 'test-thread-1',
    projectId: overrides.projectId ?? 'test-project-1',
    userId: overrides.userId ?? '__local__',
    title: overrides.title ?? 'Test Thread',
    mode: overrides.mode ?? 'local',
    status: overrides.status ?? 'pending',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
  db.insert(schema.threads).values(thread).run();
  return thread;
}

export function seedPipeline(
  db: ReturnType<typeof createTestDb>['db'],
  overrides: Partial<typeof schema.pipelines.$inferInsert> = {},
) {
  const now = new Date().toISOString();
  const pipeline = {
    id: overrides.id ?? 'test-pipeline-1',
    projectId: overrides.projectId ?? 'test-project-1',
    userId: overrides.userId ?? '__local__',
    name: overrides.name ?? 'Test Pipeline',
    enabled: overrides.enabled ?? 1,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
  db.insert(schema.pipelines).values(pipeline).run();
  return pipeline;
}

export function seedRunner(
  db: ReturnType<typeof createTestDb>['db'],
  overrides: Partial<typeof schema.runners.$inferInsert> = {},
) {
  const now = new Date().toISOString();
  const runner = {
    id: overrides.id ?? 'test-runner-1',
    name: overrides.name ?? 'Test Runner',
    hostname: overrides.hostname ?? 'localhost',
    userId: overrides.userId ?? null,
    token: overrides.token ?? 'test-token-1',
    status: overrides.status ?? 'online',
    httpUrl: overrides.httpUrl ?? 'http://localhost:3002',
    registeredAt: overrides.registeredAt ?? now,
    lastHeartbeatAt: overrides.lastHeartbeatAt ?? now,
  };
  db.insert(schema.runners).values(runner).run();
  return runner;
}

export function seedRunnerProjectAssignment(
  db: ReturnType<typeof createTestDb>['db'],
  overrides: {
    runnerId?: string;
    projectId?: string;
    localPath?: string;
  } = {},
) {
  const assignment = {
    runnerId: overrides.runnerId ?? 'test-runner-1',
    projectId: overrides.projectId ?? 'test-project-1',
    localPath: overrides.localPath ?? '/tmp/test-repo',
    assignedAt: new Date().toISOString(),
  };
  db.insert(schema.runnerProjectAssignments).values(assignment).run();
  return assignment;
}

export function seedTeamProject(
  db: ReturnType<typeof createTestDb>['db'],
  overrides: { teamId?: string; projectId?: string } = {},
) {
  const tp = {
    teamId: overrides.teamId ?? 'org-1',
    projectId: overrides.projectId ?? 'test-project-1',
    createdAt: new Date().toISOString(),
  };
  db.insert(schema.teamProjects).values(tp).run();
  return tp;
}

export function seedMessage(
  db: ReturnType<typeof createTestDb>['db'],
  overrides: Partial<typeof schema.messages.$inferInsert> = {},
) {
  const message = {
    id: overrides.id ?? 'test-msg-1',
    threadId: overrides.threadId ?? 'test-thread-1',
    role: overrides.role ?? 'user',
    content: overrides.content ?? 'Hello world',
    timestamp: overrides.timestamp ?? new Date().toISOString(),
  };
  db.insert(schema.messages).values(message).run();
  return message;
}

export function seedThreadEvent(
  db: ReturnType<typeof createTestDb>['db'],
  overrides: {
    id?: string;
    threadId?: string;
    eventType?: string;
    data?: string;
    createdAt?: string;
  } = {},
) {
  const event = {
    id: overrides.id ?? crypto.randomUUID(),
    threadId: overrides.threadId ?? 'test-thread-1',
    eventType: overrides.eventType ?? 'status_change',
    data: overrides.data ?? '{}',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
  db.insert(schema.threadEvents).values(event).run();
  return event;
}

export function seedProjectMember(
  db: ReturnType<typeof createTestDb>['db'],
  overrides: {
    projectId?: string;
    userId?: string;
    role?: string;
    localPath?: string | null;
  } = {},
) {
  const member = {
    projectId: overrides.projectId ?? 'test-project-1',
    userId: overrides.userId ?? 'user-1',
    role: overrides.role ?? 'member',
    localPath: overrides.localPath ?? null,
    joinedAt: new Date().toISOString(),
  };
  db.insert(schema.projectMembers).values(member).run();
  return member;
}
