/**
 * Unified SQLite schema — all tables for both runtime and server.
 *
 * This is the single source of truth for SQLite column definitions.
 * Both packages/runtime and packages/server import from here.
 */

import { sqliteTable, text, real, integer, primaryKey, customType } from 'drizzle-orm/sqlite-core';

/**
 * Text column that also accepts Date objects (serializes them to ISO strings).
 * Required for Better Auth's Drizzle adapter, which passes `new Date()` for timestamp fields.
 */
const dateText = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'TEXT';
  },
  toDriver(value: string | Date): string {
    return value instanceof Date ? value.toISOString() : value;
  },
  fromDriver(value: string): string {
    return value;
  },
});

import {
  DEFAULT_FOLLOW_UP_MODE,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_THREAD_MODE,
  DEFAULT_PERMISSION_MODE,
} from '../models.js';

// ── Runtime tables ─────────────────────────────────────────────

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  path: text('path').notNull(),
  color: text('color'),
  followUpMode: text('follow_up_mode').notNull().default(DEFAULT_FOLLOW_UP_MODE),
  defaultProvider: text('default_provider'),
  defaultModel: text('default_model'),
  defaultMode: text('default_mode'),
  defaultPermissionMode: text('default_permission_mode'),
  defaultBranch: text('default_branch'),
  urls: text('urls'),
  systemPrompt: text('system_prompt'),
  launcherUrl: text('launcher_url'),
  userId: text('user_id').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at').notNull(),
});

export const arcs = sqliteTable('arcs', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(),
});

export const threads = sqliteTable('threads', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  createdBy: text('created_by'),
  title: text('title').notNull(),
  mode: text('mode').notNull(),
  provider: text('provider').notNull().default(DEFAULT_PROVIDER),
  permissionMode: text('permission_mode').notNull().default(DEFAULT_PERMISSION_MODE),
  status: text('status').notNull().default('pending'),
  branch: text('branch'),
  baseBranch: text('base_branch'),
  worktreePath: text('worktree_path'),
  sessionId: text('session_id'),
  cost: real('cost').notNull().default(0),
  archived: integer('archived').notNull().default(0),
  pinned: integer('pinned').notNull().default(0),
  stage: text('stage').notNull().default('backlog'),
  model: text('model').notNull().default(DEFAULT_MODEL),
  initialPrompt: text('initial_prompt'),
  source: text('source').notNull().default('web'),
  externalRequestId: text('external_request_id'),
  parentThreadId: text('parent_thread_id'),
  arcId: text('arc_id'),
  purpose: text('purpose').notNull().default('implement'),
  runtime: text('runtime').notNull().default('local'),
  containerUrl: text('container_url'),
  containerName: text('container_name'),
  initTools: text('init_tools'),
  initCwd: text('init_cwd'),
  runnerId: text('runner_id'), // which runner handles this thread (multi/team mode)
  mergedAt: text('merged_at'), // set when worktree is merged+cleaned — explicit post-merge signal
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  threadId: text('thread_id')
    .notNull()
    .references(() => threads.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  content: text('content').notNull(),
  images: text('images'),
  model: text('model'),
  permissionMode: text('permission_mode'),
  author: text('author'),
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
  author: text('author'),
  parentToolCallId: text('parent_tool_call_id'),
});

export const automations = sqliteTable('automations', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  prompt: text('prompt').notNull(),
  schedule: text('schedule').notNull(),
  provider: text('provider').notNull().default(DEFAULT_PROVIDER),
  model: text('model').notNull().default(DEFAULT_MODEL),
  mode: text('mode').notNull().default(DEFAULT_THREAD_MODE),
  permissionMode: text('permission_mode').notNull().default(DEFAULT_PERMISSION_MODE),
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
  githubToken: text('github_token'), // legacy — migrated to providerKeys
  assemblyaiApiKey: text('assemblyai_api_key'), // legacy — migrated to providerKeys
  minimaxApiKey: text('minimax_api_key'), // legacy — migrated to providerKeys
  providerKeys: text('provider_keys'), // JSON: Record<string, encrypted_string>
  setupCompleted: integer('setup_completed').notNull().default(0),
  defaultEditor: text('default_editor'),
  useInternalEditor: integer('use_internal_editor'),
  terminalShell: text('terminal_shell'),
  toolPermissions: text('tool_permissions'),
  theme: text('theme'),
  runnerInviteToken: text('runner_invite_token'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const stageHistory = sqliteTable('stage_history', {
  id: text('id').primaryKey(),
  threadId: text('thread_id')
    .notNull()
    .references(() => threads.id, { onDelete: 'cascade' }),
  fromStage: text('from_stage'),
  toStage: text('to_stage').notNull(),
  changedAt: text('changed_at').notNull(),
});

export const threadComments = sqliteTable('thread_comments', {
  id: text('id').primaryKey(),
  threadId: text('thread_id')
    .notNull()
    .references(() => threads.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  source: text('source').notNull().default('user'),
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

export const pipelines = sqliteTable('pipelines', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  enabled: integer('enabled').notNull().default(1),
  reviewModel: text('review_model').notNull().default(DEFAULT_MODEL),
  fixModel: text('fix_model').notNull().default(DEFAULT_MODEL),
  maxIterations: integer('max_iterations').notNull().default(10),
  precommitFixEnabled: integer('precommit_fix_enabled').notNull().default(0),
  precommitFixModel: text('precommit_fix_model').notNull().default(DEFAULT_MODEL),
  precommitFixMaxIterations: integer('precommit_fix_max_iterations').notNull().default(3),
  reviewerPrompt: text('reviewer_prompt'),
  correctorPrompt: text('corrector_prompt'),
  precommitFixerPrompt: text('precommit_fixer_prompt'),
  commitMessagePrompt: text('commit_message_prompt'),
  testEnabled: integer('test_enabled').notNull().default(0),
  testCommand: text('test_command'),
  testFixEnabled: integer('test_fix_enabled').notNull().default(0),
  testFixModel: text('test_fix_model').notNull().default(DEFAULT_MODEL),
  testFixMaxIterations: integer('test_fix_max_iterations').notNull().default(3),
  testFixerPrompt: text('test_fixer_prompt'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const pipelineRuns = sqliteTable('pipeline_runs', {
  id: text('id').primaryKey(),
  pipelineId: text('pipeline_id')
    .notNull()
    .references(() => pipelines.id, { onDelete: 'cascade' }),
  threadId: text('thread_id')
    .notNull()
    .references(() => threads.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('running'),
  currentStage: text('current_stage').notNull().default('reviewer'),
  iteration: integer('iteration').notNull().default(0),
  maxIterations: integer('max_iterations').notNull().default(10),
  commitSha: text('commit_sha'),
  verdict: text('verdict'),
  findings: text('findings'),
  reviewerThreadId: text('reviewer_thread_id'),
  fixerThreadId: text('fixer_thread_id'),
  precommitIteration: integer('precommit_iteration'),
  hookName: text('hook_name'),
  hookError: text('hook_error'),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
});

export const teamProjects = sqliteTable(
  'team_projects',
  {
    teamId: text('team_id').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.teamId, table.projectId] })],
);

export const threadEvents = sqliteTable('thread_events', {
  id: text('id').primaryKey(),
  threadId: text('thread_id')
    .notNull()
    .references(() => threads.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  data: text('data').notNull(),
  createdAt: text('created_at').notNull(),
});

export const instanceSettings = sqliteTable('instance_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ── Server-only tables (multi/team mode) ───────────────────────

export const runners = sqliteTable('runners', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  hostname: text('hostname').notNull(),
  userId: text('user_id'),
  token: text('token').notNull().unique(),
  status: text('status').notNull().default('offline'),
  os: text('os').notNull().default('unknown'),
  workspace: text('workspace'),
  httpUrl: text('http_url'),
  activeThreadIds: text('active_thread_ids').notNull().default('[]'),
  registeredAt: text('registered_at').notNull(),
  lastHeartbeatAt: text('last_heartbeat_at').notNull(),
});

export const runnerProjectAssignments = sqliteTable(
  'runner_project_assignments',
  {
    runnerId: text('runner_id')
      .notNull()
      .references(() => runners.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    localPath: text('local_path').notNull(),
    assignedAt: text('assigned_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.runnerId, t.projectId] })],
);

export const runnerTasks = sqliteTable('runner_tasks', {
  id: text('id').primaryKey(),
  runnerId: text('runner_id')
    .notNull()
    .references(() => runners.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  threadId: text('thread_id').notNull(),
  payload: text('payload').notNull(),
  status: text('status').notNull().default('pending'),
  resultData: text('result_data'),
  resultError: text('result_error'),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
});

export const projectMembers = sqliteTable(
  'project_members',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    role: text('role').notNull().default('member'),
    localPath: text('local_path'),
    joinedAt: text('joined_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] })],
);

export const inviteLinks = sqliteTable('invite_links', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  token: text('token').notNull().unique(),
  role: text('role').notNull().default('member'),
  createdBy: text('created_by').notNull(),
  expiresAt: text('expires_at'),
  maxUses: text('max_uses'),
  useCount: text('use_count').notNull().default('0'),
  revoked: text('revoked').notNull().default('0'),
  createdAt: text('created_at').notNull(),
});

// ── Better Auth tables ──────────────────────────────────────────
// These must be passed explicitly to drizzleAdapter since they live
// outside the runtime schema. Column names match migration 026.

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified').notNull().default(0),
  image: text('image'),
  createdAt: dateText('created_at').notNull(),
  updatedAt: dateText('updated_at').notNull(),
  username: text('username').unique(),
  role: text('role'),
  banned: integer('banned'),
  banReason: text('ban_reason'),
  banExpires: dateText('ban_expires'),
});

export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: dateText('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: dateText('created_at').notNull(),
  updatedAt: dateText('updated_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
});

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: dateText('access_token_expires_at'),
  refreshTokenExpiresAt: dateText('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: dateText('created_at').notNull(),
  updatedAt: dateText('updated_at').notNull(),
});

export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: dateText('expires_at').notNull(),
  createdAt: dateText('created_at'),
  updatedAt: dateText('updated_at'),
});

export const organization = sqliteTable('organization', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').unique(),
  logo: text('logo'),
  createdAt: dateText('created_at').notNull(),
  metadata: text('metadata'),
});

export const member = sqliteTable('member', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  createdAt: dateText('created_at').notNull(),
});

export const invitation = sqliteTable('invitation', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role'),
  status: text('status').notNull(),
  expiresAt: dateText('expires_at').notNull(),
  inviterId: text('inviter_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
});
