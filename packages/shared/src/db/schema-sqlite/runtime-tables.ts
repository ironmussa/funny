// Runtime tables of the SQLite schema (re-exported from `../schema.sqlite.js`).
import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  real,
  integer,
  primaryKey,
  uniqueIndex,
  index,
} from 'drizzle-orm/sqlite-core';

import {
  DEFAULT_FOLLOW_UP_MODE,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_THREAD_MODE,
  DEFAULT_PERMISSION_MODE,
} from '../../models.js';

// fallow-ignore-next-line code-duplication
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  path: text('path').notNull(),
  color: text('color'),
  followUpMode: text('follow_up_mode').notNull().default(DEFAULT_FOLLOW_UP_MODE),
  fastMode: integer('fast_mode').notNull().default(0),
  redirectChecks: integer('redirect_checks').notNull().default(1),
  defaultProvider: text('default_provider'),
  defaultModel: text('default_model'),
  defaultEffort: text('default_effort'),
  // Legacy project-level thread mode. No longer the runtime source for the web
  // client (that is each user's project_sandbox_settings row,
  // project-runtime-settings); still read by the Chrome extension.
  defaultMode: text('default_mode'),
  defaultPermissionMode: text('default_permission_mode'),
  defaultBranch: text('default_branch'),
  urls: text('urls'),
  systemPrompt: text('system_prompt'),
  launcherUrl: text('launcher_url'),
  defaultAgentTemplateId: text('default_agent_template_id'), // default template for new threads
  userId: text('user_id').notNull(),
  // Owning organization for org→project role inheritance (unified-rbac-grants).
  // NULL = personal project. Replaces the `team_projects` join table.
  organizationId: text('organization_id'),
  sortOrder: integer('sort_order').notNull().default(0),
  closed: integer('closed').notNull().default(0),
  createdAt: text('created_at').notNull(),
});

export const designs = sqliteTable('designs', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  fidelity: text('fidelity'),
  speakerNotes: integer('speaker_notes').notNull().default(0),
  folderPath: text('folder_path').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Dialect mirror: schema.pg.ts and schema.sqlite.ts must declare the same columns.
// fallow-ignore-next-line code-duplication
export const threads = sqliteTable('threads', {
  id: text('id').primaryKey(),
  /** Nullable for scratch threads (no project). */
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  isScratch: integer('is_scratch').notNull().default(0),
  /** The agent may only read: the runner starts it in a read-only sandbox (migration 112). */
  readOnly: integer('read_only').notNull().default(0),
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
  designId: text('design_id'),
  runtime: text('runtime').notNull().default('local'),
  containerUrl: text('container_url'),
  containerName: text('container_name'),
  initTools: text('init_tools'),
  initCwd: text('init_cwd'),
  initSlashCommands: text('init_slash_commands'), // SDK-reported slash commands (JSON string[])
  runnerId: text('runner_id'), // which runner handles this thread (multi/team mode)
  mergedAt: text('merged_at'), // set when worktree is merged+cleaned — explicit post-merge signal
  contextRecoveryReason: text('context_recovery_reason'), // why context recovery is needed (model_changed, provider_changed)
  agentProfileId: text('agent_profile_id'),
  agentProfileName: text('agent_profile_name'),
  agentProfileProvider: text('agent_profile_provider'),
  agentTemplateId: text('agent_template_id'), // agent template used (Deep Agent only)
  templateVariables: text('template_variables'), // JSON: filled variable values
  fileCheckpointingEnabled: integer('file_checkpointing_enabled').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
});

/** Every session associated with a thread, including sessions replaced on recovery. */
export const threadSessions = sqliteTable(
  'thread_sessions',
  {
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.sessionId] }),
    index('idx_thread_sessions_session').on(table.sessionId),
  ],
);

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
  effort: text('effort'),
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

/** Durable metadata for one provider-native permission continuation. */
export const pendingPermissionRequests = sqliteTable(
  'pending_permission_requests',
  {
    requestId: text('request_id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull(),
    transport: text('transport').notNull(),
    toolCallId: text('tool_call_id').notNull(),
    toolName: text('tool_name').notNull(),
    toolInput: text('tool_input'),
    canAlwaysAllow: integer('can_always_allow').notNull().default(0),
    canDeny: integer('can_deny').notNull().default(0),
    status: text('status').notNull().default('active'),
    resolvedDecision: text('resolved_decision'),
    createdAt: text('created_at').notNull(),
    resolvedAt: text('resolved_at'),
    expiredAt: text('expired_at'),
  },
  (table) => [
    uniqueIndex('pending_permission_requests_one_active_per_run')
      .on(table.threadId, table.runId)
      .where(sql`${table.status} = 'active'`),
  ],
);

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
  effort: text('effort'),
  baseBranch: text('base_branch'),
  enabled: integer('enabled').notNull().default(1),
  maxRunHistory: integer('max_run_history').notNull().default(20),
  lastRunAt: text('last_run_at'),
  nextRunAt: text('next_run_at'),
  source: text('source').notNull().default('ui'),
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

export const watchers = sqliteTable('watchers', {
  id: text('id').primaryKey(),
  threadId: text('thread_id')
    .notNull()
    .references(() => threads.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  key: text('key').notNull(),
  label: text('label').notNull(),
  // Epoch-ms when the watcher next fires; compared in the due-time scanner.
  nextWakeAt: integer('next_wake_at').notNull(),
  lastDelayMs: integer('last_delay_ms').notNull().default(0),
  wakeCount: integer('wake_count').notNull().default(0),
  maxWakes: integer('max_wakes').notNull().default(20),
  // Epoch-ms hard lifetime ceiling; null = no deadline.
  deadline: integer('deadline'),
  status: text('status').notNull().default('pending'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  threadId: text('thread_id')
    .notNull()
    .references(() => threads.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  command: text('command').notNull(),
  cwd: text('cwd'),
  label: text('label'),
  // OS pid of the detached session leader; null until known. Liveness is
  // probed with `kill -0`; the exitfile is authoritative for completion.
  pid: integer('pid'),
  logPath: text('log_path').notNull(),
  exitPath: text('exit_path').notNull(),
  status: text('status').notNull().default('running'),
  exitCode: integer('exit_code'),
  startedAt: text('started_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// fallow-ignore-start code-duplication -- every table is declared once per dialect (SQLite and PostgreSQL)
export const activities = sqliteTable(
  'activities',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    runnerId: text('runner_id'),
    kind: text('kind').notNull(),
    projectId: text('project_id'),
    threadId: text('thread_id'),
    title: text('title').notNull(),
    status: text('status').notNull().default('running'),
    step: text('step'),
    error: text('error'),
    // JSON of the kind's input (shared/src/activities/kinds.ts).
    input: text('input').notNull().default('{}'),
    // JSON `ActivityResultRef`.
    resultRef: text('result_ref'),
    // `user` | `implicit` | `system` (track-funny-actions, design D4).
    origin: text('origin').notNull().default('user'),
    // JSON array of `ActivityEffect`.
    effects: text('effects'),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_activities_user_started').on(table.userId, table.startedAt),
    index('idx_activities_runner_status').on(table.runnerId, table.status),
  ],
);
// fallow-ignore-end code-duplication

export const userProfiles = sqliteTable('user_profiles', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().unique(),
  gitName: text('git_name'),
  gitEmail: text('git_email'),
  providerKeys: text('provider_keys'), // JSON: Record<string, encrypted_string>
  setupCompleted: integer('setup_completed').notNull().default(0),
  defaultEditor: text('default_editor'),
  useInternalEditor: integer('use_internal_editor'),
  terminalShell: text('terminal_shell'),
  toolPermissions: text('tool_permissions'),
  theme: text('theme'),
  /** JSON string[] of enabled built-in ACP provider ids; null = no override
   *  (all built-ins active — the FUNNY_PROVIDERS default). Persists the
   *  Settings > Providers toggle across runner restarts. */
  activeBuiltinProviders: text('active_builtin_providers'),
  runnerInviteToken: text('runner_invite_token'),
  /** ISO timestamp when the invite token expires; null = no expiry (legacy) */
  runnerInviteTokenExpiresAt: text('runner_invite_token_expires_at'),
  /** ISO timestamp when the invite token was first consumed; null = unused */
  runnerInviteTokenUsedAt: text('runner_invite_token_used_at'),
  /** Runner designated as this user's general runner (project-runner-binding). */
  generalRunnerId: text('general_runner_id'),
  /** JSON `UtilityModelSetting` for helper generations; null = the default (thread-recap). */
  utilityModel: text('utility_model'),
  /** 1 = show a recap when the user comes back to a thread (thread-recap). */
  threadRecapEnabled: integer('thread_recap_enabled').notNull().default(1),
  /** Minutes away from a thread before a recap is offered (thread-recap). */
  threadRecapMinAbsenceMinutes: integer('thread_recap_min_absence_minutes').notNull().default(5),
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

/**
 * Per-thread share grants. A thread owner grants a specific user read+comment
 * access to a single thread. Identity-gated: access is decided by the requesting
 * user's id against this table, not by a link/token. See the `thread-sharing`
 * change. PK `(thread_id, shared_with_user_id)` makes a re-share idempotent.
 */
export const threadShares = sqliteTable(
  'thread_shares',
  {
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    sharedWithUserId: text('shared_with_user_id').notNull(),
    sharedByUserId: text('shared_by_user_id').notNull(),
    // Permission level: 'view' (read + comment + presence) or 'steer' (view +
    // git read-only + follow-ups). See change `thread-sharing-steer`.
    level: text('level').notNull().default('view'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.sharedWithUserId] })],
);

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

/**
 * Per-user, per-project tool permission rules. Used to persist
 * "always allow in this project" choices the user makes from the
 * permission approval card.
 *
 * - `pattern` is null to match any input for that tool, otherwise
 *   for Bash it's a command prefix and for other tools it's an
 *   exact match against the serialized tool input (see
 *   serializeToolInput in agent-message-handler).
 * - `decision` is 'allow' or 'deny'.
 */
export const permissionRules = sqliteTable('permission_rules', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  projectPath: text('project_path').notNull(),
  toolName: text('tool_name').notNull(),
  pattern: text('pattern'),
  decision: text('decision').notNull(),
  createdAt: text('created_at').notNull(),
});

export const agentExecutionProfiles = sqliteTable('agent_execution_profiles', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  provider: text('provider').notNull(),
  config: text('config').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Dialect mirror: schema.pg.ts and schema.sqlite.ts must declare the same columns.
// fallow-ignore-next-line code-duplication
export const projectAgentProfileBindings = sqliteTable(
  'project_agent_profile_bindings',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    profileId: text('profile_id')
      .notNull()
      .references(() => agentExecutionProfiles.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] })],
);
