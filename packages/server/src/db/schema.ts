import { sqliteTable, text, real, integer } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  path: text('path').notNull(),
  createdAt: text('created_at').notNull(),
});

export const threads = sqliteTable('threads', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  mode: text('mode').notNull(), // 'local' | 'worktree'
  permissionMode: text('permission_mode').notNull().default('autoEdit'), // 'plan' | 'autoEdit' | 'confirmEdit'
  status: text('status').notNull().default('pending'), // 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'stopped' | 'interrupted'
  branch: text('branch'),
  baseBranch: text('base_branch'),
  worktreePath: text('worktree_path'),
  sessionId: text('session_id'),
  cost: real('cost').notNull().default(0),
  archived: integer('archived').notNull().default(0),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  threadId: text('thread_id')
    .notNull()
    .references(() => threads.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // 'user' | 'assistant' | 'system'
  content: text('content').notNull(),
  images: text('images'), // JSON-encoded ImageAttachment[]
  timestamp: text('timestamp').notNull(),
});

export const startupCommands = sqliteTable('startup_commands', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  command: text('command').notNull(),
  port: integer('port'),
  portEnvVar: text('port_env_var'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at').notNull(),
});

export const toolCalls = sqliteTable('tool_calls', {
  id: text('id').primaryKey(),
  messageId: text('message_id')
    .notNull()
    .references(() => messages.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  input: text('input'),
  output: text('output'),
});

export const automations = sqliteTable('automations', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  prompt: text('prompt').notNull(),
  schedule: text('schedule').notNull(),
  model: text('model').notNull().default('sonnet'),
  mode: text('mode').notNull().default('worktree'),
  permissionMode: text('permission_mode').notNull().default('autoEdit'),
  baseBranch: text('base_branch'),
  enabled: integer('enabled').notNull().default(1),
  maxRunHistory: integer('max_run_history').notNull().default(20),
  lastRunAt: text('last_run_at'),
  nextRunAt: text('next_run_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const automationRuns = sqliteTable('automation_runs', {
  id: text('id').primaryKey(),
  automationId: text('automation_id')
    .notNull()
    .references(() => automations.id, { onDelete: 'cascade' }),
  threadId: text('thread_id')
    .notNull()
    .references(() => threads.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('running'),
  triageStatus: text('triage_status').notNull().default('pending'),
  hasFindings: integer('has_findings'),
  summary: text('summary'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
});

export const mcpOauthTokens = sqliteTable('mcp_oauth_tokens', {
  id: text('id').primaryKey(),
  serverName: text('server_name').notNull(),
  projectPath: text('project_path').notNull(),
  serverUrl: text('server_url').notNull(),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token'),
  tokenType: text('token_type').notNull().default('Bearer'),
  expiresAt: text('expires_at'),
  scope: text('scope'),
  tokenEndpoint: text('token_endpoint'),
  clientId: text('client_id'),
  clientSecret: text('client_secret'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
