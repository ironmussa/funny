/**
 * Unified SQLite schema — all tables for both runtime and server.
 *
 * This is the single source of truth for SQLite column definitions.
 * Both packages/runtime and packages/server import from here.
 */

import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  real,
  integer,
  primaryKey,
  customType,
  uniqueIndex,
  index,
} from 'drizzle-orm/sqlite-core';

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

/**
 * Per-(project, user) issue factory (change issue-factory): a toggle plus the
 * watched label, the flow to run, and how many issues may be in flight. One row
 * per user per project; runs hang off `factory_runs`.
 */
// Dialect mirror: schema.pg.ts and schema.sqlite.ts must declare the same columns.
// fallow-ignore-next-line code-duplication
export const factorySettings = sqliteTable(
  'factory_settings',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    enabled: integer('enabled').notNull().default(0),
    label: text('label').notNull().default('ready-for-agent'),
    flowName: text('flow_name').notNull().default('issue-to-merge'),
    maxConcurrent: integer('max_concurrent').notNull().default(2),
    /** Why the watcher cannot make progress now (runner offline, App missing…); null when it can. */
    blockedReason: text('blocked_reason'),
    /**
     * What the factory admits (change factory-manual-queue): `manual`, only the
     * issues sent to it; `automatic`, also the open issues carrying `label`.
     */
    mode: text('mode').notNull().default('manual'),
    /** Which reviewed changes the factory merges by itself: `low_risk` or `all`. */
    autoMerge: text('auto_merge').notNull().default('low_risk'),
    /** JSON array of globs that make a change high risk, besides the default list. */
    sensitivePaths: text('sensitive_paths'),
    /** More counted lines than this make a change high risk (null: 400). */
    /** 1: a change over `maxLowRiskLines` is high risk (null / 0: its size does not count). */
    sizeGateEnabled: integer('size_gate_enabled'),
    maxLowRiskLines: integer('max_low_risk_lines'),
    approvalAdjustMaxLines: integer('approval_adjust_max_lines'),
    /** JSON array of globs whose lines do not count toward a change's size, besides the default list. */
    sizeIgnoredPaths: text('size_ignored_paths'),
    /** JSON object: runs inside a flow node at once, per node id. */
    stageLimits: text('stage_limits'),
    /** The merge queue's batch size (null: 5) and wait in ms (null: 60 000). */
    batchSize: integer('batch_size'),
    batchWaitMs: integer('batch_wait_ms'),
    /** `stack` (an issue starts on its blocker's branch) or `wait` (null): D10. */
    dependencies: text('dependencies'),
    /** `split` (open a too-large issue's parts as issues) or `ask` (null): comment the split. */
    tooBig: text('too_big'),
    /** 1: a run parked for a member's approval keeps its likely paths (null / 0: it holds none). */
    holdPathsAwaitingApproval: integer('hold_paths_awaiting_approval'),
    /** The branch the factory merges into; null: the repository's default branch. */
    baseBranch: text('base_branch'),
    /** JSON object of the factory's per-step overrides (`FactoryStepOverrides`), or null. */
    stepOverrides: text('step_overrides'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('factory_settings_project_user').on(t.projectId, t.userId)],
);

/**
 * One factory run per admitted issue (change issue-factory). At most one run
 * per issue is in flight: the partial unique index
 * `factory_runs_one_active_per_issue` (migration 098; since 134 it leaves out
 * every terminal state, `done` included) enforces it.
 */
// Dialect mirror: schema.pg.ts and schema.sqlite.ts must declare the same columns.
// fallow-ignore-next-line code-duplication
export const factoryRuns = sqliteTable('factory_runs', {
  id: text('id').primaryKey(),
  factoryId: text('factory_id')
    .notNull()
    .references(() => factorySettings.id, { onDelete: 'cascade' }),
  /** The run's issue; `0` for a run without one (mapped to null in `factory-runs.ts`). */
  issueNumber: integer('issue_number').notNull(),
  /** The issue's title when the run learned it (queued, or its flow read the issue); null before. */
  issueTitle: text('issue_title'),
  prUrl: text('pr_url'),
  state: text('state').notNull().default('queued'),
  currentStep: text('current_step'),
  /** JSON array of the thread ids the run's thread steps created. */
  threadIds: text('thread_ids'),
  /**
   * Set while an agent step's thread is being started and not yet recorded, so
   * a run resumed after a crash adopts that thread instead of starting another.
   */
  launchStartedAt: text('launch_started_at'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
  /** What started the run: `manual` (a sent issue), `label`, `schedule` or `run_now`. */
  source: text('source').notNull().default('label'),
  /** The flow the run executes; null on rows from before runs recorded their own. */
  flowName: text('flow_name'),
  /** Position in the factory's queue while the run is `requested`. */
  queueOrder: integer('queue_order'),
  /** JSON: why a `requested` run is not admitted yet (a blocker), or null. */
  waitReason: text('wait_reason'),
  /** When the run left the queue (`requested` → `queued`). */
  admittedAt: text('admitted_at'),
  /** JSON array of the flow's step names, in order: the run's step chain in the thread view. */
  flowSteps: text('flow_steps'),
  /** Why the run failed (the flow's error), or null; cleared when it is retried. */
  failureReason: text('failure_reason'),
  /** JSON counters of the run's integration (`FactoryRunMetrics`), or null before any. */
  metrics: text('metrics'),
  /** JSON: the last regression proof of the run (`RegressionProofRecord`). */
  regressionProof: text('regression_proof'),
  /** JSON array of the review verdicts of the run's pull request, one per commit. */
  reviews: text('review_verdicts'),
  /** JSON: the risk class of the last classified commit (`FactoryRisk`). */
  risk: text('risk'),
  /** JSON: what triage decided about the issue (`FactoryTriage`): the contract, or what it asked. */
  triage: text('triage'),
  /** Where the run's flow came from: `repository` or `built-in`; null on runs from before. */
  flowSource: text('flow_source'),
  /** The default-branch commit a repository flow (and its prompt files) was read at. */
  flowCommit: text('flow_commit'),
  /** JSON array of the options each agent step ran with (`FactoryStepOptionsRecord[]`). */
  stepOptions: text('step_options'),
  /** The node its `merge` regenerates the change with (`merge.regenerate`), or null: merged alone. */
  regenerateNode: text('regenerate_node'),
  /** An early integration waiting for the step that holds the checkout (D8), or null. */
  integrationPendingAt: text('integration_pending_at'),
  /** JSON: the run this one is stacked on (D10: run id, issue, branch, retargeted), or null. */
  stackedOn: text('stacked_on'),
  mergeApproval: text('merge_approval'),
  /** JSON `FactoryRiskWaiver`: a member marked the run as a lint cleanup; null otherwise. */
  riskWaiver: text('risk_waiver'),
  /** JSON array of the role threads (triage, review) the run started (`FactoryRoleThread[]`). */
  roleThreads: text('role_threads'),
  /** The schedule trigger that started the run (change flow-triggers); null otherwise. */
  triggerId: text('trigger_id'),
  /** The trigger's name when the run started, kept for display after an edit or a delete. */
  triggerName: text('trigger_name'),
  /** JSON object of the input values the trigger supplied; null for an issue run. */
  inputs: text('inputs'),
});

/**
 * What starts a factory flow besides an issue (change flow-triggers): a cron
 * schedule with a flow and input values. `next_run_at` is taken with a
 * compare-and-set, so one server instance starts each occurrence.
 */
// Dialect mirror: schema.pg.ts and schema.sqlite.ts must declare the same columns.
// fallow-ignore-next-line code-duplication
export const factoryTriggers = sqliteTable('factory_triggers', {
  id: text('id').primaryKey(),
  factoryId: text('factory_id')
    .notNull()
    .references(() => factorySettings.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('schedule'),
  schedule: text('schedule').notNull(),
  flowName: text('flow_name').notNull(),
  /** JSON object of the input values each run gets. */
  inputs: text('inputs'),
  enabled: integer('enabled').notNull().default(1),
  nextRunAt: text('next_run_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * A base branch that turned red after a factory merge (change
 * factory-agent-roles, D10). At most one not-closed incident per repository
 * and base branch: the partial unique index `factory_incidents_one_open`
 * (migration 111) enforces it. Admissions of every factory on the repository
 * pause while one is open.
 */
// Dialect mirror: schema.pg.ts and schema.sqlite.ts must declare the same columns.
// fallow-ignore-next-line code-duplication
export const factoryIncidents = sqliteTable('factory_incidents', {
  id: text('id').primaryKey(),
  /** `owner/name`. */
  repo: text('repo').notNull(),
  baseBranch: text('base_branch').notNull(),
  /** `open` → `investigating` → `reported` → `closed` (`factory-incidents.ts`). */
  state: text('state').notNull().default('open'),
  /** The red commit of the base branch when the incident opened. */
  redSha: text('red_sha').notNull(),
  /** JSON array of the factory merges the sentinel may name. */
  candidates: text('candidates').notNull(),
  /** The factory whose tick opened it: it runs the sentinel, as its enabler. */
  openedByFactory: text('opened_by_factory').notNull(),
  /** JSON array of the factories whose admissions it paused (they may close it). */
  affectedFactories: text('affected_factories'),
  sentinelThreadId: text('sentinel_thread_id'),
  /** JSON: what the sentinel answered and what was done (`FactoryIncidentResult`). */
  result: text('result'),
  openedAt: text('opened_at').notNull(),
  closedAt: text('closed_at'),
  /** Who closed it: a user id, or `green` when the base branch recovered. */
  closedBy: text('closed_by'),
});

/**
 * An agent's request that the member approve merging a held high-risk change
 * (openspec factory-agent-tools). Bound to one run and one commit; at most one
 * `pending` request per run (the partial unique index
 * `factory_approval_requests_one_pending`, migration 127). The request is never
 * what is approved: the member approves the run's commit, and that closes it.
 */
// Dialect mirror: schema.pg.ts and schema.sqlite.ts must declare the same columns.
// fallow-ignore-next-line code-duplication
export const factoryApprovalRequests = sqliteTable('factory_approval_requests', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  factoryId: text('factory_id').notNull(),
  projectId: text('project_id').notNull(),
  /** The thread whose agent asked. */
  threadId: text('thread_id').notNull(),
  /** The commit the run was held on when the agent asked. */
  sha: text('sha').notNull(),
  /** `pending` → `approved` | `declined` | `expired` (`factory-approval-requests.ts`). */
  state: text('state').notNull().default('pending'),
  createdAt: text('created_at').notNull(),
  resolvedAt: text('resolved_at'),
  /** Who declined or approved it; null when it expired. */
  resolvedBy: text('resolved_by'),
});

/**
 * A batch of the issue factory's merge queue (change factory-integration, D2):
 * the members one leader tests together on base commit `base_sha`. At most one
 * batch that has not ended per repository and base branch (the partial unique
 * index `factory_batches_one_active`, migration 114). States and transitions:
 * `factory-batches.ts`.
 */
// Dialect mirror: schema.pg.ts and schema.sqlite.ts must declare the same columns.
// fallow-ignore-next-line code-duplication
export const factoryBatches = sqliteTable('factory_batches', {
  id: text('id').primaryKey(),
  /** `owner/name`. */
  repo: text('repo').notNull(),
  baseBranch: text('base_branch').notNull(),
  state: text('state').notNull().default('building'),
  /** Rebuilds of the batch (the base moved, a member left), from 1. */
  attempt: integer('attempt').notNull().default(1),
  /** The run whose `merge` step leads it. */
  leaderRunId: text('leader_run_id').notNull(),
  /** JSON: the members in queue order, each with the head commit it tests. */
  members: text('members').notNull(),
  /** The base commit the batch is built on. */
  baseSha: text('base_sha'),
  /** Where the members are merged one by one (`[skip ci]` commits). */
  stagingBranch: text('staging_branch').notNull(),
  /** Where CI tests the finished batch. */
  queueBranch: text('queue_branch').notNull(),
  /** The commit CI tests on the queue branch. */
  queueSha: text('queue_sha'),
  /** JSON: how it ended (`FactoryBatchResult`). */
  result: text('result'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  endedAt: text('ended_at'),
});

/** A half of a red batch, tested on its own from the batch's base (change factory-integration, D2). */
// Dialect mirror: schema.pg.ts and schema.sqlite.ts must declare the same columns.
// fallow-ignore-next-line code-duplication
export const factoryBatchAttempts = sqliteTable('factory_batch_attempts', {
  id: text('id').primaryKey(),
  batchId: text('batch_id')
    .notNull()
    .references(() => factoryBatches.id, { onDelete: 'cascade' }),
  /** JSON: the run ids of the members it tests. */
  members: text('members').notNull(),
  branch: text('branch').notNull(),
  sha: text('sha'),
  /** `testing` → `green` | `red` | `abandoned`. */
  state: text('state').notNull().default('testing'),
  /** JSON: the failing checks of a red attempt. */
  result: text('result'),
  createdAt: text('created_at').notNull(),
  endedAt: text('ended_at'),
});

/**
 * The workflow engine's journal on the server (change workflow-dag-engine,
 * D6): one row per node execution of a run, keyed by node, visit path and
 * attempt. A run that starts again replays its rows instead of repeating
 * recorded work. `output` and `data` are JSON; times are epoch-ms. The only
 * server host is the issue factory, so rows hang off `factory_runs`.
 */
// Dialect mirror: schema.pg.ts and schema.sqlite.ts must declare the same columns.
// fallow-ignore-next-line code-duplication
export const workflowNodeExecutions = sqliteTable(
  'workflow_node_executions',
  {
    runId: text('run_id')
      .notNull()
      .references(() => factoryRuns.id, { onDelete: 'cascade' }),
    nodeId: text('node_id').notNull(),
    visit: text('visit').notNull(),
    attempt: integer('attempt').notNull(),
    status: text('status').notNull(),
    output: text('output'),
    error: text('error'),
    data: text('data'),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (t) => [primaryKey({ columns: [t.runId, t.nodeId, t.visit, t.attempt] })],
);

/**
 * Concurrency-group slots shared across server instances (D5): a lease per
 * holder (`<runId>/<nodeId>/<visit>`), renewed while the node runs and
 * expired when its server stops renewing it.
 */
// fallow-ignore-next-line code-duplication
export const workflowConcurrencyLeases = sqliteTable(
  'workflow_concurrency_leases',
  {
    groupKey: text('group_key').notNull(),
    holder: text('holder').notNull(),
    expiresAt: integer('expires_at').notNull(),
    acquiredAt: integer('acquired_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.groupKey, t.holder] })],
);

/**
 * Requests waiting for a concurrency-group slot, granted to the first
 * waiter by `priority` then `requested_at` (D5). A batching group (D5b)
 * records the leader a waiter was gathered by and the outcome it settled.
 */
// fallow-ignore-next-line code-duplication
export const workflowConcurrencyWaiters = sqliteTable(
  'workflow_concurrency_waiters',
  {
    groupKey: text('group_key').notNull(),
    holder: text('holder').notNull(),
    /** The limit this waiter's node declares (the host may have replaced it). */
    slotLimit: integer('slot_limit').notNull(),
    priority: integer('priority').notNull().default(0),
    requestedAt: integer('requested_at').notNull(),
    /** Renewed while the waiting server is alive; an expired waiter is dropped. */
    expiresAt: integer('expires_at').notNull(),
    batchMax: integer('batch_max'),
    batchWaitMs: integer('batch_wait_ms'),
    /** JSON: the waiter's input to the node, for a batch leader. */
    input: text('input'),
    /** The leader holder that gathered this waiter into its batch, or null. */
    leader: text('leader'),
    /** JSON `SettledOutcome` the leader settled, or null while pending. */
    outcome: text('outcome'),
  },
  (t) => [primaryKey({ columns: [t.groupKey, t.holder] })],
);

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

// ── Server-only tables (multi/team mode) ───────────────────────

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

// ── Better Auth tables ──────────────────────────────────────────
// These must be passed explicitly to drizzleAdapter since they live
// outside the runtime schema. Column names match migration 026.

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  // Better Auth expects real booleans (its cookie-cache payload is Zod-validated),
  // so read the 0/1 integer columns back as booleans.
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: dateText('created_at').notNull(),
  updatedAt: dateText('updated_at').notNull(),
  username: text('username').unique(),
  displayUsername: text('display_username'),
  role: text('role'),
  banned: integer('banned', { mode: 'boolean' }),
  banReason: text('ban_reason'),
  banExpires: dateText('ban_expires'),
});

// Better Auth requires matching fields in both dialect-specific schemas.
// fallow-ignore-next-line code-duplication
export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: dateText('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: dateText('created_at').notNull(),
  updatedAt: dateText('updated_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  impersonatedBy: text('impersonated_by'),
  activeOrganizationId: text('active_organization_id'),
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

// ── Agent Templates (global, per-user) ──────────────────
export const agentTemplates = sqliteTable('agent_templates', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  icon: text('icon'),
  color: text('color'),
  model: text('model'),
  systemPromptMode: text('system_prompt_mode').notNull().default('prepend'),
  systemPrompt: text('system_prompt'),
  disallowedTools: text('disallowed_tools'), // JSON array
  mcpServers: text('mcp_servers'), // JSON array
  builtinSkillsDisabled: text('builtin_skills_disabled'), // JSON array
  customSkillPaths: text('custom_skill_paths'), // JSON array
  agentName: text('agent_name'),
  shared: integer('shared', { mode: 'boolean' }).notNull().default(false), // visible to all users
  variables: text('variables'), // JSON array of template variables
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Better Auth requires matching fields in both dialect-specific schemas.
// fallow-ignore-next-line code-duplication
export const invitation = sqliteTable('invitation', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role'),
  status: text('status').notNull(),
  createdAt: dateText('created_at').notNull(),
  expiresAt: dateText('expires_at').notNull(),
  inviterId: text('inviter_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
});

/** Browser push subscriptions, isolated by authenticated user. */
export const pushSubscriptions = sqliteTable('push_subscriptions', {
  endpoint: text('endpoint').primaryKey(),
  userId: text('user_id').notNull(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
});

/**
 * Project secrets (openspec `project-secrets`): named values handed to the
 * project's agents as environment variables. `scope = 'project'` rows are
 * shared by the members and carry `user_id = ''` (not NULL: a unique index
 * treats NULLs as distinct, which would allow duplicate shared names);
 * `scope = 'user'` rows belong to one member. `ciphertext` is keyring-encrypted.
 */
export const projectSecrets = sqliteTable(
  'project_secrets',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    userId: text('user_id').notNull().default(''),
    name: text('name').notNull(),
    ciphertext: text('ciphertext').notNull(),
    allowInSandbox: integer('allow_in_sandbox').notNull().default(0),
    updatedBy: text('updated_by').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('project_secrets_scope_name').on(t.projectId, t.scope, t.userId, t.name)],
);
