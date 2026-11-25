import {
  EMPTY_FACTORY_RUN_METRICS,
  factoryRegressionProofSchema,
  factoryReviewVerdictSchema,
  factoryMergeApprovalSchema,
  factoryRiskWaiverSchema,
  factoryRiskSchema,
  factoryStackedOnSchema,
  factoryStepOptionsRecordSchema,
  factoryTriageSchema,
  MAX_STORED_REVIEWS,
  type FactoryFlowSource,
  type FactoryMergeApproval,
  type FactoryRiskWaiver,
  type FactoryRegressionProof,
  type FactoryReviewVerdict,
  type FactoryRisk,
  type FactoryRunMetrics,
  type FactoryStackedOn,
  type FactoryStepOptionsRecord,
  type FactoryStepTiming,
  type FactoryTriage,
  type FactoryWaitReason,
} from '@funny/shared/contracts/factory';
/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: value-object
 * @domain layer: domain
 *
 * The factory run's model (split out of `factory-runs.ts`): its states and the
 * transitions between them, the run view and how a stored row maps to it, and
 * how an update maps to the row's columns.
 */
import { errorMessage } from '@funny/shared/errors';
import { parseStoredJson } from '@funny/shared/json-validation';
import { and, gte, inArray, isNotNull, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import { factoryRuns } from '../../db/schema.js';

const THREAD_IDS_SCHEMA = z.array(z.string());

const STEP_NAMES_SCHEMA = z.array(z.string());

/** Counters missing from an older row read as 0 (new counters need no migration). */
const METRICS_SCHEMA = z.object({
  ciRounds: z.number().int().nonnegative().default(0),
  ciRed: z.number().int().nonnegative().default(0),
  conflicts: z.number().int().nonnegative().default(0),
  ciBlocked: z.number().int().nonnegative().default(0),
  ciTimeouts: z.number().int().nonnegative().default(0),
  agentFixes: z.number().int().nonnegative().default(0),
  reviews: z.number().int().nonnegative().default(0),
  reviewFails: z.number().int().nonnegative().default(0),
  mergeHolds: z.number().int().nonnegative().default(0),
  mergeSentBack: z.number().int().nonnegative().default(0),
  integrateRounds: z.number().int().nonnegative().default(0),
  conflictsResolvedWithoutLlm: z.number().int().nonnegative().default(0),
  conflictsSentToAgent: z.number().int().nonnegative().default(0),
  mergeRoundsToAgent: z.number().int().nonnegative().default(0),
  queueWaitMs: z.number().int().nonnegative().default(0),
  batchSize: z.number().int().nonnegative().default(0),
  bisectionRounds: z.number().int().nonnegative().default(0),
  ciFlakes: z.number().int().nonnegative().default(0),
  weaveIntegrations: z.number().int().nonnegative().default(0),
});

const WAIT_REASON_SCHEMA = z.object({
  kind: z.enum([
    'blocker-not-sent',
    'blocker-in-progress',
    'blocker-waiting-merge',
    'blocker-failed',
    'blocker-other-repo',
    'circular',
    'blockers-unreadable',
    'proof-not-configured',
    'paths-overlap',
    'paths-awaiting-approval',
    'no-free-slot',
  ]),
  blockers: z.array(z.number().int()),
});

/** States a run moves through; non-terminal ones block re-admitting the issue. */
export type FactoryRunState =
  | 'requested'
  | 'queued'
  | 'triaging'
  | 'needs_info'
  | 'working'
  | 'pr_open'
  | 'waiting_ci'
  | 'fixing'
  | 'reviewing'
  | 'merging'
  | 'waiting_human'
  | 'merged'
  | 'no_change'
  | 'done'
  | 'failed'
  | 'stopped';

export const TERMINAL_STATES = [
  'merged',
  'no_change',
  // A run without an issue whose flow finished without a pull request (change flow-triggers).
  'done',
  'failed',
  'stopped',
] as const satisfies FactoryRunState[];
export const TERMINAL: ReadonlySet<FactoryRunState> = new Set(TERMINAL_STATES);

/**
 * Non-terminal states that do NOT hold a concurrency slot: the agent is done and
 * the run waits for a person. It still blocks re-admitting its issue.
 */
export const PARKED_STATES = ['waiting_human', 'needs_info'] as const satisfies FactoryRunState[];

const PARKED: ReadonlySet<FactoryRunState> = new Set(PARKED_STATES);

/** A sent issue waiting in the factory's queue: no flow, no slot. */
export const WAITING_STATES = ['requested'] as const satisfies FactoryRunState[];

/** How a run ends without merging: what a thread must not show as done. */
export const UNMERGED_END_STATES = [
  'failed',
  'stopped',
  'no_change',
] as const satisfies FactoryRunState[];

/** States in which a run may still close by a pull request found on its branch. */
export const REOPENABLE_STATES = ['failed', 'waiting_human'] as const satisfies FactoryRunState[];

/**
 * States a run can be retried or taken over from: the ones above, and a run
 * that ended with no change (a person may disagree with the agent).
 */
export const RETRYABLE_STATES = [
  ...REOPENABLE_STATES,
  'no_change',
] as const satisfies FactoryRunState[];

/**
 * The queue's transitions, each written as a compare-and-set from the stored
 * state. Once `queued`, the flow drives the run through its own states
 * (`updateInFlight` / `advance`).
 */
export const QUEUE_TRANSITIONS = {
  /** The factory took the issue: its flow starts. */
  admit: { from: ['requested'], to: 'queued' },
  /** The flow could not start any agent (e.g. the runner is offline): back in line. */
  requeue: { from: ['queued'], to: 'requested' },
  /** Cancelled, or the queue was cleared. */
  cancel: { from: ['requested'], to: 'stopped' },
  /**
   * Triage found the run's likely paths overlap a run in progress: back in
   * line without a slot, keeping its contract, until that run is done.
   */
  hold: { from: ['triaging'], to: 'requested' },
  /** The issue changed (or a member retried): a `needs_info` run is triaged again. */
  retriage: { from: ['needs_info'], to: 'requested' },
  /**
   * A retry, merge approval or take-over found every slot taken: the run
   * waits at the head of the queue, with the steps it keeps, until one frees.
   */
  reopenQueued: { from: RETRYABLE_STATES, to: 'requested' },
  /**
   * A member split a run parked as too large: its parts are their own issues
   * now, and the run is done (as when triage splits it by itself).
   */
  split: { from: ['needs_info'], to: 'done' },
} as const satisfies Record<string, { from: readonly FactoryRunState[]; to: FactoryRunState }>;

/** States in which a flow is driving the run: neither terminal, parked nor waiting. */
export const IN_FLIGHT_STATES = [
  'queued',
  'triaging',
  'working',
  'pr_open',
  'waiting_ci',
  'fixing',
  'reviewing',
  'merging',
] as const satisfies FactoryRunState[];

/**
 * The gates after the pull request (change factory-agent-roles): a run enters
 * its review or its merge step only from a state in which it has a pull
 * request and a flow driving it, as a compare-and-set (`enterStage`). `merging`
 * covers waiting for the repository's merge slot: such a run is in flight and
 * holds one of the factory's concurrency slots.
 */
export const STAGE_TRANSITIONS = {
  review: { from: ['pr_open', 'waiting_ci', 'fixing', 'reviewing', 'merging'], to: 'reviewing' },
  merge: { from: ['pr_open', 'waiting_ci', 'fixing', 'reviewing', 'merging'], to: 'merging' },
} as const satisfies Record<string, { from: readonly FactoryRunState[]; to: FactoryRunState }>;

export type FactoryRunStage = keyof typeof STAGE_TRANSITIONS;

/** Every state a run has not ended in: waiting in line, in flight or parked. */
const LIVE_STATES = [
  ...WAITING_STATES,
  ...IN_FLIGHT_STATES,
  ...PARKED_STATES,
] as const satisfies FactoryRunState[];

/**
 * The states a flow writes while it drives a run (`updateInFlight`), each
 * with the stored states it may be written from: a compare-and-set. A state
 * missing here (`requested`, `queued`) is written only by a queue transition.
 *
 * A flow is the repository's YAML, so its steps come in any order: the work
 * states and the ends are reachable from any in-flight state. What the table
 * refuses is a run going back to triage after its work started, a parked run
 * put back to work by a flow still finishing (only a retry or take-over
 * reopens it, through `reopen`), and any write over an ended run.
 */
export const FLOW_TRANSITIONS = {
  /** Triage runs before the work; a resumed run replays its decision. */
  triaging: ['queued', 'triaging'],
  /** Triage asked questions on the issue. */
  needs_info: ['triaging'],
  working: IN_FLIGHT_STATES,
  pr_open: IN_FLIGHT_STATES,
  waiting_ci: IN_FLIGHT_STATES,
  fixing: IN_FLIGHT_STATES,
  reviewing: IN_FLIGHT_STATES,
  merging: IN_FLIGHT_STATES,
  /** The flow parks the run when it ends, also after a step already parked it. */
  waiting_human: [...IN_FLIGHT_STATES, 'waiting_human'],
  /** The merge queue may land a member whose own flow parked it. */
  merged: [...IN_FLIGHT_STATES, 'waiting_human'],
  no_change: IN_FLIGHT_STATES,
  done: IN_FLIGHT_STATES,
  failed: IN_FLIGHT_STATES,
  /** A member stops a run that has not ended, wherever it is. */
  stopped: LIVE_STATES,
} as const satisfies Partial<Record<FactoryRunState, readonly FactoryRunState[]>>;

/** A state a flow may write (`FLOW_TRANSITIONS`). */
export type FactoryFlowState = keyof typeof FLOW_TRANSITIONS;

/**
 * The stored states `to` may be written from, or null when no flow writes
 * it. Pure: what `updateInFlight` checks in its `WHERE`.
 */
export function flowTransitionFrom(to: FactoryRunState): readonly FactoryRunState[] | null {
  const byState: Partial<Record<FactoryRunState, readonly FactoryRunState[]>> = FLOW_TRANSITIONS;
  return byState[to] ?? null;
}

/**
 * The `currentStep` of a run a retry or take-over put back in flight, until its
 * flow enters a step: such a run has a history, so a flow that cannot start
 * again marks it failed instead of dropping it as never started.
 */
export const REOPENED_STEP = 'retrying';

/**
 * How long a failed run keeps showing on its thread in the thread lists. The
 * failure stays in the thread view and the project's run list after that; the
 * window only bounds what every list poll reads.
 */
export const FAILED_RUN_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The reason a run waits for a person because its change is high risk and the
 * factory merges only low-risk changes by itself: the one hold a member's
 * merge approval answers.
 */
export const HIGH_RISK_HOLD = 'high risk';

/** The branch a run's agent pushes and opens its pull request from. */
export const factoryRunBranch = (run: Pick<FactoryRunView, 'id' | 'issueNumber'>): string =>
  run.issueNumber === null
    ? `factory/run-${run.id.slice(0, 8)}`
    : `factory/issue-${run.issueNumber}-${run.id.slice(0, 8)}`;

/** How a run is named where an issue run shows `#<n>`: its issue, or its short id. */
export const factoryRunLabel = (run: Pick<FactoryRunView, 'id' | 'issueNumber'>): string =>
  run.issueNumber === null ? `run-${run.id.slice(0, 8)}` : `#${run.issueNumber}`;

/** `issue_number` of a run without an issue: the column is NOT NULL, issues start at 1. */
export const NO_ISSUE = 0;

/**
 * How long after parking a run without a recorded pull request the watcher
 * still looks for one on its branch. A flow without a `create_pr` step never
 * records one, so the branch is the only way to see a person merged it; the
 * window keeps old failures from being looked up on every tick forever.
 */
const BRANCH_LOOKUP_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Parked runs (failed, or waiting for the member) whose pull request may still
 * be merged or closed outside the factory: one is recorded, or the run parked
 * recently enough to look for one on its branch. A paused factory keeps polling
 * while it has such a run.
 */
export function awaitsPullRequest(now: number = Date.now()): SQL {
  const since = new Date(now - BRANCH_LOOKUP_WINDOW_MS).toISOString();
  return and(
    inArray(factoryRuns.state, [...REOPENABLE_STATES]),
    or(isNotNull(factoryRuns.prUrl), gte(factoryRuns.completedAt, since)),
  )!;
}

export interface FactoryRunView {
  id: string;
  factoryId: string;
  /** The run's issue; null for a run a schedule or a member started without one. */
  issueNumber: number | null;
  /** The issue's title as the run last read it; null before (and on runs without an issue). */
  issueTitle: string | null;
  /** The schedule trigger that started it, or null. */
  triggerId: string | null;
  /** That trigger's name when the run started, or null. */
  triggerName: string | null;
  /** The input values its trigger supplied; empty for an issue run. */
  inputs: Record<string, string>;
  prUrl: string | null;
  state: FactoryRunState;
  currentStep: string | null;
  threadIds: string[];
  /** When an agent thread started being launched and is not recorded yet. */
  launchStartedAt: string | null;
  startedAt: string;
  /** When the run left the queue; null while `requested`. */
  admittedAt: string | null;
  completedAt: string | null;
  source: FactoryRunSource;
  /** The flow the run executes; null on rows from before runs recorded their own. */
  flowName: string | null;
  queueOrder: number | null;
  waitReason: FactoryWaitReason | null;
  /** The flow's step names in order, once its flow started; empty before. */
  flowSteps: string[];
  /** Why the run failed, or null. */
  failureReason: string | null;
  /** How integrating its pull request went (CI rounds, conflicts, agent fixes). */
  metrics: FactoryRunMetrics;
  /** The last regression proof of its pull request, or null. */
  regressionProof: RegressionProofRecord | null;
  /** The review verdicts of its pull request, one per commit, oldest first. */
  reviews: FactoryReviewVerdict[];
  /** The risk class of the last classified commit, or null. */
  risk: FactoryRisk | null;
  /** What triage decided about the issue, or null before it ran. */
  triage: FactoryTriage | null;
  /** Where the run's flow came from; null on rows from before runs recorded it. */
  flowSource: FactoryFlowSource | null;
  /** The default-branch commit a repository flow was read at; null for a built-in. */
  flowCommit: string | null;
  /** The node its `merge` regenerates the change with (D9): such a run is merged alone. */
  regenerateNode: string | null;
  /** The run this one is stacked on (D10), or null. */
  stackedOn: FactoryStackedOn | null;
  /** A member's approval to merge its high-risk head commit, or null. */
  mergeApproval: FactoryMergeApproval | null;
  /** A member's statement that the run is a lint cleanup, or null. */
  riskWaiver: FactoryRiskWaiver | null;
  /** The options each agent step ran with, in the order the steps started. */
  stepOptions: FactoryStepOptionsRecord[];
  /** Each flow node execution, in start order; only the run lists read it (openspec factory-step-timings). */
  stepTimings?: FactoryStepTiming[];
}

export type FactoryRunSource = 'manual' | 'label' | 'schedule' | 'run_now';

const RUN_SOURCES: readonly FactoryRunSource[] = ['manual', 'label', 'schedule', 'run_now'];

const sourceOf = (stored: string): FactoryRunSource =>
  RUN_SOURCES.find((source) => source === stored) ?? 'label';

/**
 * Every thread a run started: its implementing agent's (`threadIds`, the
 * steps a retry replays), its triage agent's, then its reviewers' (kept with
 * their verdicts).
 * What stopping the run stops and what a merge cleans up.
 */
export function threadsOf(run: Pick<FactoryRunView, 'threadIds' | 'reviews' | 'triage'>): string[] {
  const reviewers = run.reviews.flatMap((review) => (review.threadId ? [review.threadId] : []));
  const triage = run.triage?.threadId ? [run.triage.threadId] : [];
  return [...new Set([...run.threadIds, ...triage, ...reviewers])];
}

export type FactoryRunsError =
  | { kind: 'storage'; message: string }
  /**
   * A flow wrote a state the run's stored state does not lead to
   * (`FLOW_TRANSITIONS`): nothing was written, and the run is still live.
   */
  | { kind: 'illegal-transition'; message: string; from: FactoryRunState; to: FactoryRunState };

export type Row = typeof factoryRuns.$inferSelect;

export const storage = (cause: unknown): FactoryRunsError => ({
  kind: 'storage',
  message: errorMessage(cause),
});

/** The run's own columns, stored as they are. */
const plainFieldsOf = (row: Row) => ({
  id: row.id,
  factoryId: row.factoryId,
  issueNumber: row.issueNumber === NO_ISSUE ? null : row.issueNumber,
  issueTitle: row.issueTitle ?? null,
  triggerId: row.triggerId ?? null,
  triggerName: row.triggerName ?? null,
  inputs: parseStoredInputs(row.inputs ?? null, 'factory_runs.inputs'),
  prUrl: row.prUrl,
  // SAFETY: factory_runs.state is written only in this module, always from a FactoryRunState value.
  state: row.state as FactoryRunState,
  currentStep: row.currentStep,
  launchStartedAt: row.launchStartedAt ?? null,
  startedAt: row.startedAt,
  admittedAt: row.admittedAt ?? null,
  completedAt: row.completedAt,
  source: sourceOf(row.source),
  failureReason: row.failureReason ?? null,
});

/** Its place in the queue and the flow it executes. */
const queueAndFlowOf = (row: Row) => ({
  flowName: row.flowName ?? null,
  queueOrder: row.queueOrder ?? null,
  waitReason: parseWaitReason(row.waitReason ?? null),
  flowSource: flowSourceOf(row.flowSource ?? null),
  flowCommit: row.flowCommit ?? null,
  regenerateNode: row.regenerateNode ?? null,
  stackedOn: parseStackedOn(row.stackedOn ?? null),
  mergeApproval: parseMergeApproval(row.mergeApproval ?? null),
  riskWaiver: parseRiskWaiver(row.riskWaiver ?? null),
});

/** The stored merge approval, or null (none, or no longer readable: nothing is approved). */
export function parseMergeApproval(raw: string | null): FactoryMergeApproval | null {
  if (!raw) return null;
  const parsed = parseStoredJson(factoryMergeApprovalSchema, raw, 'factory_runs.merge_approval');
  return parsed.ok ? parsed.value : null;
}

/** The stored waiver, or null (none, or no longer readable: nothing is waived). */
function parseRiskWaiver(raw: string | null): FactoryRiskWaiver | null {
  if (!raw) return null;
  const parsed = parseStoredJson(factoryRiskWaiverSchema, raw, 'factory_runs.risk_waiver');
  return parsed.ok ? parsed.value : null;
}

/** The stored blocker of a stacked run, or null (none, or no longer readable). */
function parseStackedOn(raw: string | null): FactoryStackedOn | null {
  if (!raw) return null;
  const parsed = parseStoredJson(factoryStackedOnSchema, raw, 'factory_runs.stacked_on');
  return parsed.ok ? parsed.value : null;
}

/** The columns stored as JSON, parsed (a value that no longer parses reads as empty). */
const jsonFieldsOf = (row: Row) => ({
  threadIds: parseThreadIds(row.threadIds),
  flowSteps: parseStepNames(row.flowSteps ?? null),
  metrics: parseMetrics(row.metrics ?? null),
  regressionProof: parseRegressionProof(row.regressionProof ?? null),
  reviews: parseReviews(row.reviews ?? null),
  risk: parseRisk(row.risk ?? null),
  triage: parseTriage(row.triage ?? null),
  stepOptions: parseStepOptions(row.stepOptions ?? null),
});

export const toView = (row: Row): FactoryRunView => ({
  ...plainFieldsOf(row),
  ...queueAndFlowOf(row),
  ...jsonFieldsOf(row),
});

const flowSourceOf = (raw: string | null): FactoryFlowSource | null =>
  raw === 'repository' || raw === 'built-in' ? raw : null;

const STEP_OPTIONS_SCHEMA = z.array(factoryStepOptionsRecordSchema);

function parseStepOptions(raw: string | null): FactoryStepOptionsRecord[] {
  if (!raw) return [];
  const parsed = parseStoredJson(STEP_OPTIONS_SCHEMA, raw, 'factory_runs.step_options');
  return parsed.ok ? parsed.value : [];
}

const INPUTS_SCHEMA = z.record(z.string(), z.string());

/** Stored input values (a run's, a trigger's); a value that no longer parses reads as none. */
export function parseStoredInputs(raw: string | null, column: string): Record<string, string> {
  if (!raw) return {};
  const parsed = parseStoredJson(INPUTS_SCHEMA, raw, column);
  return parsed.ok ? parsed.value : {};
}

function parseTriage(raw: string | null): FactoryTriage | null {
  if (!raw) return null;
  const parsed = parseStoredJson(factoryTriageSchema, raw, 'factory_runs.triage');
  return parsed.ok ? parsed.value : null;
}

const REVIEWS_SCHEMA = z.array(factoryReviewVerdictSchema);

function parseReviews(raw: string | null): FactoryReviewVerdict[] {
  if (!raw) return [];
  const parsed = parseStoredJson(REVIEWS_SCHEMA, raw, 'factory_runs.review_verdicts');
  return parsed.ok ? parsed.value : [];
}

function parseRisk(raw: string | null): FactoryRisk | null {
  if (!raw) return null;
  const parsed = parseStoredJson(factoryRiskSchema, raw, 'factory_runs.risk');
  return parsed.ok ? parsed.value : null;
}

/**
 * The run's verdicts with `verdict` added: one per commit (a new verdict of a
 * commit replaces the old one), oldest first, the newest `MAX_STORED_REVIEWS`.
 */
export function withReviewVerdict(
  reviews: readonly FactoryReviewVerdict[],
  verdict: FactoryReviewVerdict,
): FactoryReviewVerdict[] {
  const others = reviews.filter((review) => review.sha !== verdict.sha);
  return [...others, verdict].slice(-MAX_STORED_REVIEWS);
}

function parseWaitReason(raw: string | null): FactoryWaitReason | null {
  if (!raw) return null;
  const parsed = parseStoredJson(WAIT_REASON_SCHEMA, raw, 'factory_runs.wait_reason');
  return parsed.ok ? parsed.value : null;
}

function parseThreadIds(raw: string | null): string[] {
  if (!raw) return [];
  const parsed = parseStoredJson(THREAD_IDS_SCHEMA, raw, 'factory_runs.thread_ids');
  return parsed.ok ? parsed.value : [];
}

function parseMetrics(raw: string | null): FactoryRunMetrics {
  if (!raw) return { ...EMPTY_FACTORY_RUN_METRICS };
  const parsed = parseStoredJson(METRICS_SCHEMA, raw, 'factory_runs.metrics');
  return parsed.ok ? parsed.value : { ...EMPTY_FACTORY_RUN_METRICS };
}

function parseRegressionProof(raw: string | null): RegressionProofRecord | null {
  if (!raw) return null;
  const parsed = parseStoredJson(
    factoryRegressionProofSchema,
    raw,
    'factory_runs.regression_proof',
  );
  return parsed.ok ? parsed.value : null;
}

function parseStepNames(raw: string | null): string[] {
  if (!raw) return [];
  const parsed = parseStoredJson(STEP_NAMES_SCHEMA, raw, 'factory_runs.flow_steps');
  return parsed.ok ? parsed.value : [];
}

export interface StartRunInput {
  factoryId: string;
  /** The run's issue, or null for a run without one. */
  issueNumber: number | null;
  /** The issue's title, when the caller has read it. */
  issueTitle?: string;
  /** The schedule trigger that starts it, with its name as of now. */
  trigger?: { id: string; name: string };
  /** The input values the trigger supplies. */
  inputs?: Record<string, string>;
  state?: FactoryRunState;
  threadIds?: string[];
  currentStep?: string;
  /** Defaults to `label` (the automatic-mode admission). */
  source?: FactoryRunSource;
  flowName?: string;
}

/** What the run stores of a regression proof (the contract's shape). */
export type RegressionProofRecord = FactoryRegressionProof;

export interface UpdateRunInput {
  /** The issue's title, as the flow read it. */
  issueTitle?: string;
  /** Written only along `FLOW_TRANSITIONS`. */
  state?: FactoryFlowState;
  currentStep?: string | null;
  prUrl?: string | null;
  threadIds?: string[];
  launchStartedAt?: string | null;
  flowSteps?: string[];
  failureReason?: string | null;
  metrics?: FactoryRunMetrics;
  regressionProof?: RegressionProofRecord;
  reviews?: FactoryReviewVerdict[];
  risk?: FactoryRisk;
  triage?: FactoryTriage;
  flowSource?: FactoryFlowSource;
  flowCommit?: string | null;
  /** Every step's options so far (the run appends and writes the whole list). */
  stepOptions?: FactoryStepOptionsRecord[];
  /** The node its `merge` regenerates the change with (D9), or null. */
  regenerateNode?: string | null;
  /** When an early integration started waiting for the step holding the checkout (D8), or null. */
  integrationPendingAt?: string | null;
  /** The run this one is stacked on (D10). */
  stackedOn?: FactoryStackedOn | null;
}

/** Update fields stored as they are, and the ones stored as JSON. */
const PLAIN_FIELDS = [
  'issueTitle',
  'currentStep',
  'prUrl',
  'launchStartedAt',
  'failureReason',
  'flowSource',
  'flowCommit',
  'regenerateNode',
  'integrationPendingAt',
] as const;
const JSON_FIELDS = [
  'threadIds',
  'flowSteps',
  'metrics',
  'regressionProof',
  'reviews',
  'risk',
  'triage',
  'stepOptions',
  'stackedOn',
] as const;

export function changesFor(input: UpdateRunInput): Partial<Row> | null {
  const changes: Partial<Row> = {};
  if (input.state !== undefined) {
    changes.state = input.state;
    // A parked run's flow ended too: when it parked is when a take-over may follow.
    if (TERMINAL.has(input.state) || PARKED.has(input.state)) {
      changes.completedAt = new Date().toISOString();
    }
  }
  for (const field of PLAIN_FIELDS) {
    if (input[field] !== undefined) changes[field] = input[field];
  }
  for (const field of JSON_FIELDS) {
    if (input[field] !== undefined) changes[field] = JSON.stringify(input[field]);
  }
  return Object.keys(changes).length === 0 ? null : changes;
}

/** A new run's row: every column empty, with `given` on top. */
export function newRunRow(
  given: Pick<Row, 'id' | 'factoryId' | 'issueNumber' | 'state' | 'source'> & Partial<Row>,
): Row {
  return {
    prUrl: null,
    currentStep: null,
    threadIds: JSON.stringify([]),
    launchStartedAt: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    flowName: null,
    queueOrder: null,
    waitReason: null,
    admittedAt: null,
    flowSteps: null,
    failureReason: null,
    metrics: null,
    regressionProof: null,
    reviews: null,
    risk: null,
    triage: null,
    flowSource: null,
    flowCommit: null,
    stepOptions: null,
    regenerateNode: null,
    integrationPendingAt: null,
    stackedOn: null,
    mergeApproval: null,
    riskWaiver: null,
    issueTitle: null,
    triggerId: null,
    triggerName: null,
    inputs: null,
    ...given,
  };
}

/** The trigger columns of a run started by a trigger (change flow-triggers). */
export const triggerFieldsOf = (input: {
  trigger?: { id: string; name: string };
  inputs?: Record<string, string>;
}) => ({
  triggerId: input.trigger?.id ?? null,
  triggerName: input.trigger?.name ?? null,
  inputs: input.inputs ? JSON.stringify(input.inputs) : null,
});
