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
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL DEFAULT '',
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
      design_id TEXT,
      agent_template_id TEXT,
      template_variables TEXT,
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
      file_checkpointing_enabled INTEGER NOT NULL DEFAULT 0,
      orchestrator_managed INTEGER NOT NULL DEFAULT 0,
      is_scratch INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT '',
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
      author TEXT
    )
  `);

  testDb.run(sql`
    CREATE TABLE IF NOT EXISTS pipelines (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL DEFAULT '',
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
      provider_keys TEXT,
      active_builtin_providers TEXT,
      runner_invite_token TEXT,
      runner_invite_token_expires_at TEXT,
      runner_invite_token_used_at TEXT,
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
      public_media_url TEXT,
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
    CREATE TABLE IF NOT EXISTS project_member_config (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      local_path TEXT,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (project_id, user_id)
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
    userId: overrides.userId ?? 'user-1',
    organizationId: overrides.organizationId ?? null,
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
    userId: overrides.userId ?? 'user-1',
    title: overrides.title ?? 'Test Thread',
    mode: overrides.mode ?? 'local',
    status: overrides.status ?? 'pending',
    orchestratorManaged: overrides.orchestratorManaged ?? 1,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
    ...overrides,
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
    userId: overrides.userId ?? 'user-1',
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
    ...overrides,
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
    author: overrides.author ?? null,
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

export function seedResourceGrant(
  db: ReturnType<typeof createTestDb>['db'],
  overrides: {
    subjectId?: string;
    resourceType?: string;
    resourceId?: string;
    role?: string;
    grantedBy?: string;
  } = {},
) {
  const grant = {
    subjectId: overrides.subjectId ?? 'user-1',
    resourceType: overrides.resourceType ?? 'thread',
    resourceId: overrides.resourceId ?? 'test-thread-1',
    role: overrides.role ?? 'viewer',
    grantedBy: overrides.grantedBy ?? 'owner-1',
    createdAt: new Date().toISOString(),
  };
  db.insert(schema.resourceGrants).values(grant).run();
  return grant;
}

export function seedMessageQueue(
  db: ReturnType<typeof createTestDb>['db'],
  overrides: {
    id?: string;
    threadId?: string;
    content?: string;
    sortOrder?: number;
  } = {},
) {
  const entry = {
    id: overrides.id ?? crypto.randomUUID(),
    threadId: overrides.threadId ?? 'test-thread-1',
    content: overrides.content ?? 'Queued message',
    sortOrder: overrides.sortOrder ?? 0,
    createdAt: new Date().toISOString(),
  };
  db.insert(schema.messageQueue).values(entry).run();
  return entry;
}

export function seedStageHistory(
  db: ReturnType<typeof createTestDb>['db'],
  overrides: {
    id?: string;
    threadId?: string;
    fromStage?: string | null;
    toStage?: string;
    changedAt?: string;
  } = {},
) {
  const row = {
    id: overrides.id ?? crypto.randomUUID(),
    threadId: overrides.threadId ?? 'test-thread-1',
    fromStage: overrides.fromStage ?? 'backlog',
    toStage: overrides.toStage ?? 'planning',
    changedAt: overrides.changedAt ?? new Date().toISOString(),
  };
  db.insert(schema.stageHistory).values(row).run();
  return row;
}

export function seedInviteLink(
  db: ReturnType<typeof createTestDb>['db'],
  overrides: Partial<typeof schema.inviteLinks.$inferInsert> = {},
) {
  const link = {
    id: overrides.id ?? crypto.randomUUID(),
    organizationId: overrides.organizationId ?? 'org-acme',
    token: overrides.token ?? `token-${crypto.randomUUID()}`,
    role: overrides.role ?? 'member',
    createdBy: overrides.createdBy ?? 'admin-1',
    expiresAt: overrides.expiresAt ?? null,
    maxUses: overrides.maxUses ?? null,
    useCount: overrides.useCount ?? '0',
    revoked: overrides.revoked ?? '0',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    ...overrides,
  };
  db.insert(schema.inviteLinks).values(link).run();
  return link;
}

export function seedOrchestratorRun(
  db: ReturnType<typeof createTestDb>['db'],
  overrides: {
    threadId?: string;
    userId?: string;
    pipelineRunId?: string | null;
    attempt?: number;
  } = {},
) {
  const now = Date.now();
  const row = {
    threadId: overrides.threadId ?? 'test-thread-1',
    pipelineRunId: overrides.pipelineRunId ?? null,
    attempt: overrides.attempt ?? 0,
    nextRetryAtMs: null,
    lastEventAtMs: now,
    lastError: null,
    claimedAtMs: now,
    userId: overrides.userId ?? 'user-1',
    tokensTotal: 0,
    updatedAtMs: now,
    ...overrides,
  };
  db.insert(schema.orchestratorRuns).values(row).run();
  return row;
}

export function seedAutomation(
  db: ReturnType<typeof createTestDb>['db'],
  overrides: Partial<typeof schema.automations.$inferInsert> = {},
) {
  const now = new Date().toISOString();
  const automation = {
    id: overrides.id ?? 'auto-1',
    projectId: overrides.projectId ?? 'test-project-1',
    userId: overrides.userId ?? 'user-1',
    name: overrides.name ?? 'Nightly Review',
    prompt: overrides.prompt ?? 'Review open PRs',
    schedule: overrides.schedule ?? '0 9 * * *',
    enabled: overrides.enabled ?? 1,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    ...overrides,
  };
  db.insert(schema.automations).values(automation).run();
  return automation;
}

export function seedAutomationRun(
  db: ReturnType<typeof createTestDb>['db'],
  overrides: Partial<typeof schema.automationRuns.$inferInsert> = {},
) {
  const now = new Date().toISOString();
  const run = {
    id: overrides.id ?? 'run-1',
    automationId: overrides.automationId ?? 'auto-1',
    threadId: overrides.threadId ?? 'test-thread-1',
    status: overrides.status ?? 'completed',
    triageStatus: overrides.triageStatus ?? 'pending',
    startedAt: overrides.startedAt ?? now,
    completedAt: overrides.completedAt ?? now,
    ...overrides,
  };
  db.insert(schema.automationRuns).values(run).run();
  return run;
}

export function seedPipelineRun(
  db: ReturnType<typeof createTestDb>['db'],
  overrides: Partial<typeof schema.pipelineRuns.$inferInsert> = {},
) {
  const now = new Date().toISOString();
  const run = {
    id: overrides.id ?? 'pipeline-run-1',
    pipelineId: overrides.pipelineId ?? 'test-pipeline-1',
    threadId: overrides.threadId ?? 'test-thread-1',
    status: overrides.status ?? 'running',
    createdAt: overrides.createdAt ?? now,
    ...overrides,
  };
  db.insert(schema.pipelineRuns).values(run).run();
  return run;
}

export function seedThreadDependency(
  db: ReturnType<typeof createTestDb>['db'],
  overrides: { threadId?: string; blockedBy?: string } = {},
) {
  const row = {
    threadId: overrides.threadId ?? 'test-thread-1',
    blockedBy: overrides.blockedBy ?? 'blocker-thread-1',
  };
  db.insert(schema.threadDependencies).values(row).run();
  return row;
}

export function seedToolCall(
  db: ReturnType<typeof createTestDb>['db'],
  overrides: {
    id?: string;
    messageId?: string;
    name?: string;
    input?: string;
    output?: string | null;
  } = {},
) {
  const row = {
    id: overrides.id ?? 'tc-1',
    messageId: overrides.messageId ?? 'test-msg-1',
    name: overrides.name ?? 'Write',
    input: overrides.input ?? JSON.stringify({ file_path: 'src/index.ts' }),
    output: overrides.output !== undefined ? overrides.output : null,
  };
  db.insert(schema.toolCalls).values(row).run();
  return row;
}

export function seedRunnerTask(
  db: ReturnType<typeof createTestDb>['db'],
  overrides: {
    id?: string;
    runnerId?: string;
    threadId?: string;
    type?: string;
    status?: string;
    payload?: string;
  } = {},
) {
  const row = {
    id: overrides.id ?? 'task-1',
    runnerId: overrides.runnerId ?? 'test-runner-1',
    threadId: overrides.threadId ?? 'test-thread-1',
    type: overrides.type ?? 'start_agent',
    payload: overrides.payload ?? JSON.stringify({ threadId: 'test-thread-1' }),
    status: overrides.status ?? 'pending',
    createdAt: new Date().toISOString(),
  };
  db.insert(schema.runnerTasks).values(row).run();
  return row;
}
