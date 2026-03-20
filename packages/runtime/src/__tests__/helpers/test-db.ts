/**
 * In-memory SQLite database for testing.
 * Creates a fresh DB with the same schema for each test suite.
 */
import { Database } from 'bun:sqlite';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';

import * as schema from '../../db/schema.js';

export function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');

  const testDb = drizzle(sqlite, { schema });

  // Create tables
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
      model TEXT NOT NULL DEFAULT 'sonnet',
      initial_prompt TEXT,
      source TEXT NOT NULL DEFAULT 'web',
      external_request_id TEXT,
      parent_thread_id TEXT,
      runtime TEXT NOT NULL DEFAULT 'local',
      container_url TEXT,
      container_name TEXT,
      init_tools TEXT,
      init_cwd TEXT,
      runner_id TEXT,
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
    CREATE TABLE IF NOT EXISTS startup_commands (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      command TEXT NOT NULL,
      port INTEGER,
      port_env_var TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
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
    CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL DEFAULT '__local__',
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'claude',
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

  testDb.run(sql`
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

  testDb.run(sql`
    CREATE TABLE IF NOT EXISTS user_profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      git_name TEXT,
      git_email TEXT,
      github_token TEXT,
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

  testDb.run(sql`
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

  testDb.run(sql`
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

  return { db: testDb, sqlite, schema };
}

/** Insert a test pipeline and return it */
export function seedPipeline(
  db: ReturnType<typeof createTestDb>['db'],
  overrides: Partial<typeof schema.pipelines.$inferInsert> = {},
) {
  const pipeline = {
    id: overrides.id ?? 'test-pipeline-1',
    projectId: overrides.projectId ?? 'test-project-1',
    name: overrides.name ?? 'Test Pipeline',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
  };
  db.insert(schema.pipelines).values(pipeline).run();
  return pipeline;
}

/** Insert a test project and return it */
export function seedProject(
  db: ReturnType<typeof createTestDb>['db'],
  overrides: Partial<typeof schema.projects.$inferInsert> = {},
) {
  const project = {
    id: overrides.id ?? 'test-project-1',
    name: overrides.name ?? 'Test Project',
    path: overrides.path ?? '/tmp/test-repo',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
  db.insert(schema.projects).values(project).run();
  return project;
}

/** Insert a test thread and return it */
export function seedThread(
  db: ReturnType<typeof createTestDb>['db'],
  overrides: Partial<typeof schema.threads.$inferInsert> = {},
) {
  const thread = {
    id: overrides.id ?? 'test-thread-1',
    projectId: overrides.projectId ?? 'test-project-1',
    userId: overrides.userId ?? 'user-1',
    title: overrides.title ?? 'Test Thread',
    mode: overrides.mode ?? 'local',
    provider: overrides.provider ?? 'claude',
    permissionMode: overrides.permissionMode ?? 'autoEdit',
    status: overrides.status ?? 'pending',
    branch: overrides.branch ?? null,
    worktreePath: overrides.worktreePath ?? null,
    sessionId: overrides.sessionId ?? null,
    cost: overrides.cost ?? 0,
    archived: overrides.archived ?? 0,
    pinned: overrides.pinned ?? 0,
    stage: overrides.stage ?? 'backlog',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    completedAt: overrides.completedAt ?? null,
  };
  db.insert(schema.threads).values(thread).run();
  return thread;
}

/** Insert a test message and return it */
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

/** Insert a test tool call and return it */
export function seedToolCall(
  db: ReturnType<typeof createTestDb>['db'],
  overrides: Partial<typeof schema.toolCalls.$inferInsert> = {},
) {
  const toolCall = {
    id: overrides.id ?? 'test-tc-1',
    messageId: overrides.messageId ?? 'test-msg-1',
    name: overrides.name ?? 'Read',
    input: overrides.input ?? '{"file": "test.ts"}',
    output: overrides.output ?? null,
  };
  db.insert(schema.toolCalls).values(toolCall).run();
  return toolCall;
}
