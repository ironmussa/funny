// ── Server-only tables (multi/team mode) ───────────────────────
// Re-exported from `../schema.sqlite.js`.
import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';

import { projects } from './runtime-tables.js';

// Dialect mirror: schema.pg.ts and schema.sqlite.ts must declare the same columns.
// fallow-ignore-next-line code-duplication
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
  publicMediaUrl: text('public_media_url'),
  /** 'general' serves projectless + non-overridden work; 'dedicated' only its projects. */
  role: text('role').notNull().default('general'),
  /** For role 'sandbox': the only thread this runner may serve (change thread-sandboxes). */
  threadId: text('thread_id'),
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

/**
 * Per-project runner policy (project-runner-binding). A row with a
 * `dedicatedRunnerId` overrides the owner's general runner: the project then
 * runs ONLY on that runner plus explicit grants. `githubToken` is an optional
 * encrypted per-project git credential overriding the owner's PAT.
 */
export const projectRunnerSettings = sqliteTable('project_runner_settings', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  dedicatedRunnerId: text('dedicated_runner_id'),
  githubToken: text('github_token'),
  updatedAt: text('updated_at').notNull(),
});

/**
 * Explicit, user-configured access grants of a runner to a project. Unlike
 * `runner_project_assignments` (a location record runners write themselves),
 * a grant is an authorization decision made from the project's settings.
 */
export const projectRunnerGrants = sqliteTable(
  'project_runner_grants',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    runnerId: text('runner_id')
      .notNull()
      .references(() => runners.id, { onDelete: 'cascade' }),
    grantedBy: text('granted_by').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.runnerId] })],
);

/**
 * One row (id = 1) whose `version` increments on every change to runner
 * routing policy (runner role, general runner, dedicated runner, grants,
 * sandbox binding, runner deletion). Every server instance compares it with
 * the version its routing caches were filled at and drops them when it moved,
 * so a revocation applies on all instances at once (runner-scope.ts).
 */
export const runnerPolicyVersion = sqliteTable('runner_policy_version', {
  id: integer('id').primaryKey(),
  version: integer('version').notNull(),
});

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

/**
 * Unified resource-access grants (unified-rbac-grants). One row = one subject's
 * canonical role on one resource. `resource_type` ∈ {'org','project','thread'};
 * `role` is the canonical lattice value {'owner','admin','contributor','viewer'}.
 * The composite PK makes a re-grant idempotent. Collapses `project_members.role`,
 * `thread_shares`, and `team_projects` behind a single authorizer that walks the
 * thread→project→org inheritance chain. Org rows are shadow-synced from Better
 * Auth `member` (which stays canonical for org membership).
 */
export const resourceGrants = sqliteTable(
  'resource_grants',
  {
    subjectId: text('subject_id').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    role: text('role').notNull(),
    grantedBy: text('granted_by').notNull(),
    createdAt: text('created_at').notNull(),
  },
  // Lookup indexes (idx_resource_grants_resource / _subject) are created in the
  // server migration, matching how thread_shares' index is defined.
  (t) => [primaryKey({ columns: [t.subjectId, t.resourceType, t.resourceId] })],
);

/**
 * Per-collaborator project configuration, split out from authorization
 * (unified-rbac-grants). Holds the member's own local working directory for a
 * project — a config fact, not an access fact. Membership/role lives in
 * `resource_grants`; this table only answers "where is this user's local copy?".
 */
export const projectMemberConfig = sqliteTable(
  'project_member_config',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
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

// Dialect mirror: schema.pg.ts and schema.sqlite.ts must declare the same columns.
// fallow-ignore-next-line code-duplication
export const runnerEnrollments = sqliteTable('runner_enrollments', {
  id: text('id').primaryKey(),
  /** Short, human-readable code shown to the operator (unique). */
  userCode: text('user_code').notNull().unique(),
  /** Hash of the long poll token the runner holds (unique). */
  pollTokenHash: text('poll_token_hash').notNull().unique(),
  /** pending | approved | consumed */
  status: text('status').notNull().default('pending'),
  hostname: text('hostname').notNull(),
  os: text('os').notNull().default('unknown'),
  /** Originating IP of the runner's start request (shown to the approver). */
  ip: text('ip'),
  /** Set on approval — the registered runner id to deliver. */
  runnerId: text('runner_id'),
  /** Set on approval — the runner bearer token to deliver once. */
  runnerToken: text('runner_token'),
  approverUserId: text('approver_user_id'),
  /** Failed approval attempts against this code (lockout guard). */
  failedAttempts: integer('failed_attempts').notNull().default(0),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
});

/**
 * The sandbox a thread runs in (change thread-sandboxes): which provider
 * account and machine, its runner, and the normalized lifecycle state.
 */
// Dialect mirror: schema.pg.ts and schema.sqlite.ts must declare the same columns.
// fallow-ignore-next-line code-duplication
export const threadSandboxes = sqliteTable('thread_sandboxes', {
  threadId: text('thread_id').primaryKey(),
  userId: text('user_id').notNull(),
  connectionId: text('connection_id').notNull(),
  provider: text('provider').notNull(),
  /** Provider machine id; null until the provider accepted the create. */
  sandboxId: text('sandbox_id'),
  runnerId: text('runner_id'),
  sizeId: text('size_id').notNull(),
  /** Repository cloned into the sandbox; reused for the project's next sandbox. */
  repoUrl: text('repo_url'),
  /** SHA-256 of the sandbox's LLM proxy token; the row going away revokes it. */
  llmTokenHash: text('llm_token_hash'),
  /** How the runner reaches the server: `direct` (null) or `reverse` (the server dials in). */
  runnerLink: text('runner_link'),
  /** provisioning | installing | connecting | bootstrapping | running | stopping | stopped | failed | lost */
  state: text('state').notNull(),
  error: text('error'),
  /** Bumped on every re-provision; part of the provider idempotency key. */
  generation: integer('generation').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * A user's credential for a sandbox provider such as Boat (change
 * thread-sandboxes). The credential is encrypted at rest and never returned.
 */
// Dialect mirror: schema.pg.ts and schema.sqlite.ts must declare the same columns.
// fallow-ignore-next-line code-duplication
export const infraConnections = sqliteTable('infra_connections', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  provider: text('provider').notNull(),
  label: text('label').notNull(),
  /** Non-secret provider config, validated by the provider's schema. */
  configJson: text('config_json').notNull().default('{}'),
  credentialEnc: text('credential_enc').notNull(),
  /** Account label reported by the provider at validation time. */
  accountLabel: text('account_label'),
  createdAt: text('created_at').notNull(),
  lastValidatedAt: text('last_validated_at'),
});

/**
 * A user's sandbox for one project (change project-sandboxes): which of their
 * own provider connections new threads use, at what size, and whether the
 * composer starts with the sandbox on. Per user, so in a shared project nobody
 * launches machines on another member's account. Rows of a connection are
 * removed with it by the connection service.
 */
// Dialect mirror: schema.pg.ts and schema.sqlite.ts must declare the same columns.
// fallow-ignore-next-line code-duplication
export const projectSandboxSettings = sqliteTable(
  'project_sandbox_settings',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    connectionId: text('connection_id').notNull(),
    sizeId: text('size_id').notNull(),
    // Where this user's new threads run on this project: 'local' | 'worktree' | 'sandbox'.
    // connection_id/size_id are only meaningful when mode = 'sandbox'.
    mode: text('mode').notNull().default('local'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] })],
);

/**
 * Single-use, short-lived token that lets a freshly provisioned sandbox runner
 * register itself as the `sandbox` runner of one thread without device-link
 * approval (change thread-sandboxes). Only the SHA-256 hash is stored.
 */
// Dialect mirror: schema.pg.ts and schema.sqlite.ts must declare the same columns.
// fallow-ignore-next-line code-duplication
export const runnerProvisionTokens = sqliteTable('runner_provision_tokens', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  userId: text('user_id').notNull(),
  projectId: text('project_id'),
  threadId: text('thread_id').notNull(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  /** Set atomically when a runner registers with the token. */
  usedAt: text('used_at'),
  /** The runner created by the registration. */
  runnerId: text('runner_id'),
});

/**
 * Personal API tokens (openspec public-rest-api-v1): a user's credential for
 * the public REST API `/api/v1`, and nothing else. Only the SHA-256 hash of the
 * token is stored; `prefix` is its first characters, to tell tokens apart in
 * the list. A token stops working once `revoked_at` is set or `expires_at` is
 * past.
 */
// Dialect mirror: schema.pg.ts and schema.sqlite.ts must declare the same columns.
// fallow-ignore-next-line code-duplication
export const personalAccessTokens = sqliteTable('personal_access_tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  prefix: text('prefix').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
});

export const runnerOperationIdempotency = sqliteTable(
  'runner_operation_idempotency',
  {
    runnerId: text('runner_id').notNull(),
    operationKind: text('operation_kind').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    status: text('status').notNull(),
    outcomeJson: text('outcome_json'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.runnerId, t.operationKind, t.idempotencyKey] })],
);

export const runnerEventReceipts = sqliteTable(
  'runner_event_receipts',
  {
    runnerId: text('runner_id').notNull(),
    threadId: text('thread_id').notNull(),
    executionId: text('execution_id').notNull(),
    highestContiguousSequence: text('highest_contiguous_sequence').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.runnerId, t.executionId] })],
);
