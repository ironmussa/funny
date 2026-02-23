import { sqliteTable, text, real, integer } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  path: text('path').notNull(),
  color: text('color'),
  followUpMode: text('follow_up_mode').notNull().default('interrupt'), // 'interrupt' | 'queue'
  defaultProvider: text('default_provider'), // nullable — null means "use global default"
  defaultModel: text('default_model'),
  defaultMode: text('default_mode'),
  defaultPermissionMode: text('default_permission_mode'),
  userId: text('user_id').notNull().default('__local__'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at').notNull(),
});

export const threads = sqliteTable('threads', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().default('__local__'),
  createdBy: text('created_by'), // Username, external agent ID, or pipeline/automation name
  title: text('title').notNull(),
  mode: text('mode').notNull(), // 'local' | 'worktree'
  provider: text('provider').notNull().default('claude'), // 'claude' | 'codex'
  permissionMode: text('permission_mode').notNull().default('autoEdit'), // 'plan' | 'autoEdit' | 'confirmEdit'
  status: text('status').notNull().default('pending'), // 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'stopped' | 'interrupted'
  branch: text('branch'),
  baseBranch: text('base_branch'),
  worktreePath: text('worktree_path'),
  sessionId: text('session_id'),
  cost: real('cost').notNull().default(0),
  archived: integer('archived').notNull().default(0),
  pinned: integer('pinned').notNull().default(0),
  stage: text('stage').notNull().default('backlog'), // 'backlog' | 'planning' | 'in_progress' | 'review' | 'done'
  model: text('model').notNull().default('sonnet'), // 'sonnet' | 'opus' | 'haiku'
  initialPrompt: text('initial_prompt'),
  source: text('source').notNull().default('web'), // 'web' | 'chrome_extension' | 'api' | 'automation' | 'ingest'
  externalRequestId: text('external_request_id'),
  parentThreadId: text('parent_thread_id'),
  initTools: text('init_tools'),   // JSON-encoded string[] of available tools
  initCwd: text('init_cwd'),       // Working directory reported by agent
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
  model: text('model'), // Claude model used for this message (user messages only)
  permissionMode: text('permission_mode'), // Permission mode used for this message (user messages only)
  author: text('author'), // Who produced this message: 'user', 'assistant', 'agent:tests', 'orchestrator', etc.
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
  author: text('author'), // Agent name that executed this tool call (for pipeline threads)
});

export const automations = sqliteTable('automations', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().default('__local__'),
  name: text('name').notNull(),
  prompt: text('prompt').notNull(),
  schedule: text('schedule').notNull(),
  provider: text('provider').notNull().default('claude'), // 'claude' | 'codex'
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

export const userProfiles = sqliteTable('user_profiles', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().unique(),
  gitName: text('git_name'),
  gitEmail: text('git_email'),
  githubToken: text('github_token'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const stageHistory = sqliteTable('stage_history', {
  id: text('id').primaryKey(),
  threadId: text('thread_id')
    .notNull()
    .references(() => threads.id, { onDelete: 'cascade' }),
  fromStage: text('from_stage'), // null for initial entry
  toStage: text('to_stage').notNull(),
  changedAt: text('changed_at').notNull(),
});

export const threadComments = sqliteTable('thread_comments', {
  id: text('id').primaryKey(),
  threadId: text('thread_id')
    .notNull()
    .references(() => threads.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  source: text('source').notNull().default('user'), // 'user' | 'system' | 'agent'
  content: text('content').notNull(),
  createdAt: text('created_at').notNull(),
});

export const messageQueue = sqliteTable('message_queue', {
  id: text('id').primaryKey(),
  threadId: text('thread_id')
    .notNull()
    .references(() => threads.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  provider: text('provider'),
  model: text('model'),
  permissionMode: text('permission_mode'),
  images: text('images'),
  allowedTools: text('allowed_tools'),
  disallowedTools: text('disallowed_tools'),
  fileReferences: text('file_references'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at').notNull(),
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
