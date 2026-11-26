// Issue factory and workflow tables of the SQLite schema (re-exported from
// `../schema.sqlite.js`).
import { sqliteTable, text, integer, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core';

import { projects } from './runtime-tables.js';

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
    /** What a label starts with to name a lane (change factory-lanes); null: `feature:`. */
    laneLabelPrefix: text('lane_label_prefix'),
    /** What a lane's branch starts with; null: `feature/`. */
    laneBranchPrefix: text('lane_branch_prefix'),
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
  // Who put the run on hold, why, when and from which state (JSON, `FactoryRunHold`).
  hold: text('hold'),
  /** JSON array of the role threads (triage, review) the run started (`FactoryRoleThread[]`). */
  roleThreads: text('role_threads'),
  /** The schedule trigger that started the run (change flow-triggers); null otherwise. */
  triggerId: text('trigger_id'),
  /** The trigger's name when the run started, kept for display after an edit or a delete. */
  triggerName: text('trigger_name'),
  /** JSON object of the input values the trigger supplied; null for an issue run. */
  inputs: text('inputs'),
  /**
   * The branch the run starts from and merges into, decided at admission
   * (change factory-lanes, D2); null on runs from before: the factory's setting.
   */
  baseBranch: text('base_branch'),
  /** The lane it was admitted to (the lane's name), or null: the factory's own branch. */
  lane: text('lane'),
  /** The commit the run's merge made on its base branch; null until it merges. */
  mergeSha: text('merge_sha'),
});

/**
 * A lane of a factory (change factory-lanes): the issues labelled
 * `<lane label prefix><name>` run on `branch`. Created when the factory first
 * admits such an issue. `sync_state` is the lane-sync machine of
 * `factory-lane-sync.ts`, written with compare-and-set.
 */
// Dialect mirror: schema.pg.ts and schema.sqlite.ts must declare the same columns.
// fallow-ignore-next-line code-duplication
export const factoryLanes = sqliteTable(
  'factory_lanes',
  {
    id: text('id').primaryKey(),
    factoryId: text('factory_id')
      .notNull()
      .references(() => factorySettings.id, { onDelete: 'cascade' }),
    /** The lane's name, lower-cased: the label without its prefix. */
    name: text('name').notNull(),
    branch: text('branch').notNull(),
    /** `active` → `finished` (its final pull request merged). */
    state: text('state').notNull().default('active'),
    /** Why the repository's workflows may not run for this branch, or null. */
    ciWarning: text('ci_warning'),
    createdAt: text('created_at').notNull(),
    /** `idle` | `merging` | `resolving` | `checking` | `needs_human`. */
    syncState: text('sync_state').notNull().default('idle'),
    /** The base head the sync in flight brings in. */
    syncBaseSha: text('sync_base_sha'),
    syncPrNumber: integer('sync_pr_number'),
    syncThreadId: text('sync_thread_id'),
    syncAttempts: integer('sync_attempts').notNull().default(0),
    syncStartedAt: text('sync_started_at'),
    syncError: text('sync_error'),
    /** The base head the lane's branch last took in. */
    lastSyncedBaseSha: text('last_synced_base_sha'),
    /** The pull request that merges the lane into the factory's base, once asked. */
    finishPrNumber: integer('finish_pr_number'),
  },
  (t) => [uniqueIndex('factory_lanes_factory_name').on(t.factoryId, t.name)],
);

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
