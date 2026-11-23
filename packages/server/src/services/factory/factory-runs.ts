/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: application
 *
 * Factory runs (change issue-factory): one row per admitted issue, holding the
 * run's state, its PR and the thread ids of its thread steps. The watcher reads
 * `activeByIssue` for admission (one run per issue) and the Factory tab lists
 * them per factory.
 *
 * Issues sent from funny (change factory-manual-queue) wait in `requested`: a
 * non-terminal state, so the one-run-per-issue index already holds the issue,
 * but neither in flight (nothing drives it) nor holding a concurrency slot.
 * Leaving the queue is a compare-and-set (`QUEUE_TRANSITIONS`).
 */
import {
  EMPTY_FACTORY_RUN_METRICS,
  factoryRegressionProofSchema,
  factoryReviewVerdictSchema,
  factoryRiskSchema,
  factoryTriageSchema,
  MAX_STORED_REVIEWS,
  type FactoryRegressionProof,
  type FactoryReviewVerdict,
  type FactoryRisk,
  type FactoryRunMetrics,
  type FactoryTriage,
  type FactoryWaitReason,
} from '@funny/shared/contracts/factory';
import { parseStoredJson } from '@funny/shared/json-validation';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  like,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { okAsync, ResultAsync } from 'neverthrow';
import { z } from 'zod';

import { db, dbDialect, withDatabaseTransaction } from '../../db/index.js';
import { factoryRuns, factorySettings, workflowNodeExecutions } from '../../db/schema.js';
import { syncRunThreadStages } from './factory-thread-stage.js';

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
  | 'failed'
  | 'stopped';

const TERMINAL_STATES = [
  'merged',
  'no_change',
  'failed',
  'stopped',
] as const satisfies FactoryRunState[];
const TERMINAL: ReadonlySet<FactoryRunState> = new Set(TERMINAL_STATES);

/**
 * Non-terminal states that do NOT hold a concurrency slot: the agent is done and
 * the run waits for a person. It still blocks re-admitting its issue.
 */
const PARKED_STATES = ['waiting_human', 'needs_info'] as const satisfies FactoryRunState[];

const PARKED: ReadonlySet<FactoryRunState> = new Set(PARKED_STATES);

/** A sent issue waiting in the factory's queue: no flow, no slot. */
const WAITING_STATES = ['requested'] as const satisfies FactoryRunState[];

/**
 * The queue's transitions, each written as a compare-and-set from the stored
 * state. Once `queued`, the flow drives the run through its own states
 * (`updateInFlight` / `advance`).
 */
const QUEUE_TRANSITIONS = {
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
const STAGE_TRANSITIONS = {
  review: { from: ['pr_open', 'waiting_ci', 'fixing', 'reviewing', 'merging'], to: 'reviewing' },
  merge: { from: ['pr_open', 'waiting_ci', 'fixing', 'reviewing', 'merging'], to: 'merging' },
} as const satisfies Record<string, { from: readonly FactoryRunState[]; to: FactoryRunState }>;

export type FactoryRunStage = keyof typeof STAGE_TRANSITIONS;

/**
 * The `currentStep` of a run a retry or take-over put back in flight, until its
 * flow enters a step: such a run has a history, so a flow that cannot start
 * again marks it failed instead of dropping it as never started.
 */
export const REOPENED_STEP = 'retrying';

/** States in which a run may still close by a pull request found on its branch. */
const REOPENABLE_STATES = ['failed', 'waiting_human'] as const satisfies FactoryRunState[];

/**
 * States a run can be retried or taken over from: the ones above, and a run
 * that ended with no change (a person may disagree with the agent).
 */
const RETRYABLE_STATES = [...REOPENABLE_STATES, 'no_change'] as const satisfies FactoryRunState[];

/**
 * How long a failed run keeps showing on its thread in the thread lists. The
 * failure stays in the thread view and the project's run list after that; the
 * window only bounds what every list poll reads.
 */
const FAILED_RUN_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** The branch a run's agent pushes and opens its pull request from. */
export const factoryRunBranch = (run: Pick<FactoryRunView, 'id' | 'issueNumber'>): string =>
  `factory/issue-${run.issueNumber}-${run.id.slice(0, 8)}`;

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
  issueNumber: number;
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
}

export type FactoryRunSource = 'manual' | 'label';

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

export type FactoryRunsError = { kind: 'storage'; message: string };

type Row = typeof factoryRuns.$inferSelect;

const storage = (error: unknown): FactoryRunsError => ({
  kind: 'storage',
  message: error instanceof Error ? error.message : String(error),
});

const toView = (row: Row): FactoryRunView => ({
  id: row.id,
  factoryId: row.factoryId,
  issueNumber: row.issueNumber,
  prUrl: row.prUrl,
  state: row.state as FactoryRunState,
  currentStep: row.currentStep,
  threadIds: parseThreadIds(row.threadIds),
  launchStartedAt: row.launchStartedAt ?? null,
  startedAt: row.startedAt,
  admittedAt: row.admittedAt ?? null,
  completedAt: row.completedAt,
  source: row.source === 'manual' ? 'manual' : 'label',
  flowName: row.flowName ?? null,
  queueOrder: row.queueOrder ?? null,
  waitReason: parseWaitReason(row.waitReason ?? null),
  flowSteps: parseStepNames(row.flowSteps ?? null),
  failureReason: row.failureReason ?? null,
  metrics: parseMetrics(row.metrics ?? null),
  regressionProof: parseRegressionProof(row.regressionProof ?? null),
  reviews: parseReviews(row.reviews ?? null),
  risk: parseRisk(row.risk ?? null),
  triage: parseTriage(row.triage ?? null),
});

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
  issueNumber: number;
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
  state?: FactoryRunState;
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
}

/** Update fields stored as they are, and the ones stored as JSON. */
const PLAIN_FIELDS = ['currentStep', 'prUrl', 'launchStartedAt', 'failureReason'] as const;
const JSON_FIELDS = [
  'threadIds',
  'flowSteps',
  'metrics',
  'regressionProof',
  'reviews',
  'risk',
  'triage',
] as const;

function changesFor(input: UpdateRunInput): Partial<Row> | null {
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

/**
 * Write `changes` to a run only while it is parked (failed, or waiting for the
 * member): a compare-and-set. Resolves whether it was parked.
 */
function updateFromParked(
  runId: string,
  changes: Partial<Row>,
  from: readonly FactoryRunState[] = REOPENABLE_STATES,
): ResultAsync<boolean, FactoryRunsError> {
  return ResultAsync.fromPromise(
    db
      .update(factoryRuns)
      .set(changes)
      .where(and(eq(factoryRuns.id, runId), inArray(factoryRuns.state, [...from])))
      .returning({ id: factoryRuns.id }),
    storage,
  ).map((rows) => rows.length > 0);
}

/**
 * Move one run along a queue transition, only from the transition's stored
 * states (a compare-and-set). Resolves whether the run moved.
 */
function moveRun(
  runId: string,
  transition: 'admit' | 'requeue' | 'hold' | 'retriage',
  changes: Partial<Row>,
): ResultAsync<boolean, FactoryRunsError> {
  const { from, to } = QUEUE_TRANSITIONS[transition];
  return ResultAsync.fromPromise(
    db
      .update(factoryRuns)
      .set({ ...changes, state: to })
      .where(and(eq(factoryRuns.id, runId), inArray(factoryRuns.state, [...from])))
      .returning({ id: factoryRuns.id }),
    storage,
  ).map((rows) => rows.length > 0);
}

/** A slot-taking write refused: the factory already runs `maxConcurrent` runs. */
export const NO_FREE_SLOT = 'no-free-slot' as const;

/** Runs of a factory holding a concurrency slot (`IN_FLIGHT_STATES`). */
const holdsSlot = (factoryId: string): SQL =>
  and(eq(factoryRuns.factoryId, factoryId), inArray(factoryRuns.state, [...IN_FLIGHT_STATES]))!;

/** Per factory: the tail of the in-process chain that serializes slot-taking writes. */
const slotLocks = new Map<string, Promise<unknown>>();

/**
 * Hold a Postgres advisory lock on the factory's slots until the transaction
 * ends, so slot-taking writes of every server instance run one at a time.
 */
async function lockSlotsAcrossServers(factoryId: string): Promise<void> {
  // SAFETY: only called on the Postgres dialect, whose Drizzle database has `execute`.
  const pg = db as { execute?: (query: SQL) => Promise<unknown> };
  await pg.execute?.(sql`SELECT pg_advisory_xact_lock(hashtext(${`factory-slots:${factoryId}`}))`);
}

/** Whether the factory runs fewer runs than its stored `maxConcurrent`. */
async function hasFreeSlot(factoryId: string): Promise<boolean> {
  const [factory] = await db
    .select({ max: factorySettings.maxConcurrent })
    .from(factorySettings)
    .where(eq(factorySettings.id, factoryId));
  if (!factory) return false;
  const [active] = await db.select({ n: count() }).from(factoryRuns).where(holdsSlot(factoryId));
  return Number(active?.n ?? 0) < factory.max;
}

/**
 * Run a write that puts a run of `factoryId` in flight (admit, label admission,
 * retry, take-over) only when the factory has a free slot, with the check and
 * the write as one step (issue #328): serialized per factory in this process,
 * and on Postgres in one transaction holding an advisory lock on the factory,
 * so writers on other server instances wait too (SQLite runs one server).
 * Resolves `take`'s result, or `NO_FREE_SLOT` without calling it.
 */
function withFreeSlot<T>(
  factoryId: string,
  take: () => Promise<T>,
): ResultAsync<T | typeof NO_FREE_SLOT, FactoryRunsError> {
  const previous = slotLocks.get(factoryId) ?? Promise.resolve();
  const run = previous.then(() =>
    withDatabaseTransaction(async () => {
      if (dbDialect === 'pg') await lockSlotsAcrossServers(factoryId);
      return (await hasFreeSlot(factoryId)) ? take() : NO_FREE_SLOT;
    }),
  );
  const tail = run.catch(() => undefined);
  slotLocks.set(factoryId, tail);
  void tail.then(() => {
    if (slotLocks.get(factoryId) === tail) slotLocks.delete(factoryId);
  });
  return ResultAsync.fromPromise(run, storage);
}

/**
 * The queue's reads and writes (change factory-manual-queue): sent issues wait
 * in `requested` until the watcher admits them; each move out of the queue is
 * a compare-and-set from the stored state (`QUEUE_TRANSITIONS`).
 */
function queueOperations(newId: () => string) {
  return {
    /**
     * Queue sent issues, in the given order, behind the factory's queue, in one
     * statement: either every new row is written or none is. An issue the
     * one-run-per-issue index already holds (a run waiting, in flight or
     * parked) is skipped by the conflict clause and reported as a duplicate;
     * its position is left unused. Two sends racing may share a position; send
     * time breaks the tie.
     */
    enqueue(input: {
      factoryId: string;
      issueNumbers: number[];
      flowName: string;
    }): ResultAsync<{ queued: FactoryRunView[]; duplicates: number[] }, FactoryRunsError> {
      return ResultAsync.fromPromise(
        (async () => {
          const [last] = await db
            .select({ order: factoryRuns.queueOrder })
            .from(factoryRuns)
            .where(eq(factoryRuns.factoryId, input.factoryId))
            .orderBy(desc(factoryRuns.queueOrder))
            .limit(1);
          const first = (last?.order ?? 0) + 1;
          const now = new Date().toISOString();
          const rows: Row[] = input.issueNumbers.map((issueNumber, index) => ({
            id: newId(),
            factoryId: input.factoryId,
            issueNumber,
            prUrl: null,
            state: 'requested',
            currentStep: null,
            threadIds: JSON.stringify([]),
            launchStartedAt: null,
            startedAt: now,
            completedAt: null,
            source: 'manual',
            flowName: input.flowName,
            queueOrder: first + index,
            waitReason: null,
            admittedAt: null,
            flowSteps: null,
            failureReason: null,
            metrics: null,
            regressionProof: null,
            reviews: null,
            risk: null,
            triage: null,
          }));
          const written = await db
            .insert(factoryRuns)
            .values(rows)
            .onConflictDoNothing()
            .returning({ id: factoryRuns.id });
          const ids = new Set(written.map((row) => row.id));
          return {
            queued: rows.flatMap((row) => (ids.has(row.id) ? [toView(row)] : [])),
            duplicates: rows.flatMap((row) => (ids.has(row.id) ? [] : [row.issueNumber])),
          };
        })(),
        storage,
      );
    },

    /** The factory's waiting issues, first to admit first. */
    queue(factoryId: string): ResultAsync<FactoryRunView[], FactoryRunsError> {
      return ResultAsync.fromPromise(
        db
          .select()
          .from(factoryRuns)
          .where(and(eq(factoryRuns.factoryId, factoryId), eq(factoryRuns.state, 'requested')))
          .orderBy(asc(factoryRuns.queueOrder), asc(factoryRuns.startedAt), asc(factoryRuns.id)),
        storage,
      ).map((rows) => rows.map(toView));
    },

    /**
     * `requested → queued` when the factory has a free slot (`withFreeSlot`):
     * `admitted`, `NO_FREE_SLOT`, or `gone` when the run left the queue
     * meanwhile (cancelled).
     */
    admit: (
      factoryId: string,
      runId: string,
    ): ResultAsync<'admitted' | 'gone' | typeof NO_FREE_SLOT, FactoryRunsError> =>
      withFreeSlot(factoryId, async () => {
        const moved = await moveRun(runId, 'admit', {
          admittedAt: new Date().toISOString(),
          waitReason: null,
        });
        if (moved.isErr()) throw new Error(moved.error.message);
        return moved.value ? ('admitted' as const) : ('gone' as const);
      }),

    /** `queued → requested`, keeping its place: its flow could not start any agent. */
    requeue: (runId: string) =>
      moveRun(runId, 'requeue', {
        admittedAt: null,
        currentStep: null,
        launchStartedAt: null,
        failureReason: null,
      }),

    /**
     * `triaging → requested`: the run's likely paths overlap those of `blockers`
     * (issues with a run in progress). It leaves its slot and keeps its contract.
     */
    holdForPaths: (runId: string, blockers: number[]) =>
      moveRun(runId, 'hold', {
        admittedAt: null,
        currentStep: null,
        launchStartedAt: null,
        waitReason: JSON.stringify({ kind: 'paths-overlap', blockers }),
      }),

    /**
     * `needs_info → requested`: the issue changed since triage asked, or a
     * member retried. Its old answer is marked superseded, so triage runs
     * again on a new thread.
     */
    retriage: (run: Pick<FactoryRunView, 'id' | 'triage'>) =>
      moveRun(run.id, 'retriage', {
        admittedAt: null,
        currentStep: null,
        launchStartedAt: null,
        completedAt: null,
        failureReason: null,
        triage: run.triage ? JSON.stringify({ ...run.triage, superseded: true }) : null,
      }),

    /** The factory's runs waiting on their issue (`needs_info`). */
    needingInfo(factoryId: string): ResultAsync<FactoryRunView[], FactoryRunsError> {
      return ResultAsync.fromPromise(
        db
          .select()
          .from(factoryRuns)
          .where(and(eq(factoryRuns.factoryId, factoryId), eq(factoryRuns.state, 'needs_info'))),
        storage,
      ).map((rows) => rows.map(toView));
    },

    /**
     * `requested → stopped` for one run, or for every waiting run of the factory
     * when `runId` is omitted (Clear queue). Resolves the runs it stopped.
     */
    cancel(factoryId: string, runId?: string): ResultAsync<string[], FactoryRunsError> {
      const { from, to } = QUEUE_TRANSITIONS.cancel;
      return ResultAsync.fromPromise(
        db
          .update(factoryRuns)
          .set({ state: to, completedAt: new Date().toISOString(), waitReason: null })
          .where(
            and(
              eq(factoryRuns.factoryId, factoryId),
              inArray(factoryRuns.state, [...from]),
              runId === undefined ? undefined : eq(factoryRuns.id, runId),
            ),
          )
          .returning({ id: factoryRuns.id }),
        storage,
      ).map((rows) => rows.map((row) => row.id));
    },

    /** Record why a waiting run is not admitted yet (null: nothing holds it back). */
    setWaitReason(
      runId: string,
      reason: FactoryWaitReason | null,
    ): ResultAsync<void, FactoryRunsError> {
      return ResultAsync.fromPromise(
        db
          .update(factoryRuns)
          .set({ waitReason: reason ? JSON.stringify(reason) : null })
          .where(and(eq(factoryRuns.id, runId), eq(factoryRuns.state, 'requested'))),
        storage,
      ).map(() => undefined);
    },
  };
}

/**
 * After a write that set the run's `state`, move its threads' kanban stage to
 * match (`syncRunThreadStages`, which reads the stored state). Passes `wrote`
 * through; a sync failure is logged there and never fails the write.
 */
function afterStateWrite(
  runId: string,
  input: Pick<UpdateRunInput, 'state'>,
  wrote: boolean,
): ResultAsync<boolean, FactoryRunsError> {
  if (!wrote || input.state === undefined) return okAsync(wrote);
  return syncRunThreadStages(runId).map(() => wrote);
}

export function createFactoryRunsRepository(
  deps: { newId: () => string } = { newId: () => crypto.randomUUID() },
) {
  /** Runs holding a concurrency slot: non-terminal and not parked for a person. */
  const inFlight = (factoryId: string): ResultAsync<FactoryRunView[], FactoryRunsError> =>
    ResultAsync.fromPromise(
      db
        .select()
        .from(factoryRuns)
        .where(
          and(
            eq(factoryRuns.factoryId, factoryId),
            notInArray(factoryRuns.state, [
              ...TERMINAL_STATES,
              ...PARKED_STATES,
              ...WAITING_STATES,
            ]),
          ),
        ),
      storage,
    ).map((rows) => rows.map(toView));

  /** Insert a run row as given. */
  const insertRun = (input: StartRunInput): ResultAsync<FactoryRunView, FactoryRunsError> => {
    const row: Row = {
      id: deps.newId(),
      factoryId: input.factoryId,
      issueNumber: input.issueNumber,
      prUrl: null,
      state: input.state ?? 'queued',
      currentStep: input.currentStep ?? null,
      threadIds: JSON.stringify(input.threadIds ?? []),
      launchStartedAt: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      source: input.source ?? 'label',
      flowName: input.flowName ?? null,
      queueOrder: null,
      waitReason: null,
      admittedAt: input.state === 'requested' ? null : new Date().toISOString(),
      flowSteps: null,
      failureReason: null,
      metrics: null,
      regressionProof: null,
      reviews: null,
      risk: null,
      triage: null,
    };
    return ResultAsync.fromPromise(db.insert(factoryRuns).values(row), storage).map(() =>
      toView(row),
    );
  };

  return {
    /** Runs for a factory, newest first. */
    list(factoryId: string): ResultAsync<FactoryRunView[], FactoryRunsError> {
      return ResultAsync.fromPromise(
        db
          .select()
          .from(factoryRuns)
          .where(eq(factoryRuns.factoryId, factoryId))
          .orderBy(desc(factoryRuns.startedAt)),
        storage,
      ).map((rows) => rows.map(toView));
    },

    /**
     * The runs of every factory `userId` owns that the thread lists show on
     * their threads: not ended (in flight, or parked waiting for the member),
     * or failed within `FAILED_RUN_WINDOW_MS`. A thread shows busy while its run
     * works outside the agent (CI, merge), and the error icon once it failed.
     * Queued (`requested`) runs have no thread yet.
     */
    activeForOwner(
      userId: string,
      now: number = Date.now(),
    ): ResultAsync<FactoryRunView[], FactoryRunsError> {
      const failedSince = new Date(now - FAILED_RUN_WINDOW_MS).toISOString();
      return ResultAsync.fromPromise(
        db
          .select({ run: factoryRuns })
          .from(factoryRuns)
          .innerJoin(factorySettings, eq(factorySettings.id, factoryRuns.factoryId))
          .where(
            and(
              eq(factorySettings.userId, userId),
              or(
                notInArray(factoryRuns.state, [...TERMINAL_STATES, ...WAITING_STATES]),
                and(eq(factoryRuns.state, 'failed'), gte(factoryRuns.completedAt, failedSince)),
              ),
            ),
          ),
        storage,
      ).map((rows) => rows.map(({ run }) => toView(run)));
    },

    /**
     * What the factory view lists: every run of `userId`'s factories that has
     * not ended (queued, in flight, or waiting for the member), or ended (merged,
     * failed, stopped) within `FAILED_RUN_WINDOW_MS`, with the project its
     * factory belongs to.
     */
    queueForOwner(
      userId: string,
      now: number = Date.now(),
    ): ResultAsync<Array<FactoryRunView & { projectId: string }>, FactoryRunsError> {
      const endedSince = new Date(now - FAILED_RUN_WINDOW_MS).toISOString();
      return ResultAsync.fromPromise(
        db
          .select({ run: factoryRuns, projectId: factorySettings.projectId })
          .from(factoryRuns)
          .innerJoin(factorySettings, eq(factorySettings.id, factoryRuns.factoryId))
          .where(
            and(
              eq(factorySettings.userId, userId),
              or(
                notInArray(factoryRuns.state, [...TERMINAL_STATES]),
                gte(factoryRuns.completedAt, endedSince),
              ),
            ),
          )
          .orderBy(desc(factoryRuns.startedAt)),
        storage,
      ).map((rows) => rows.map(({ run, projectId }) => ({ ...toView(run), projectId })));
    },

    /** The non-terminal run for an issue, if any — the admission dedup check. */
    activeByIssue(
      factoryId: string,
      issueNumber: number,
    ): ResultAsync<FactoryRunView | null, FactoryRunsError> {
      return ResultAsync.fromPromise(
        db
          .select()
          .from(factoryRuns)
          .where(
            and(
              eq(factoryRuns.factoryId, factoryId),
              eq(factoryRuns.issueNumber, issueNumber),
              notInArray(factoryRuns.state, [...TERMINAL_STATES]),
            ),
          ),
        storage,
      ).map((rows) => (rows[0] ? toView(rows[0]) : null));
    },

    /**
     * Whether a run of the issue ended with no change: the label does not admit
     * it again (the agent would only say the same). A person sends or retries it.
     */
    endedWithoutChange(
      factoryId: string,
      issueNumber: number,
    ): ResultAsync<boolean, FactoryRunsError> {
      return ResultAsync.fromPromise(
        db
          .select({ id: factoryRuns.id })
          .from(factoryRuns)
          .where(
            and(
              eq(factoryRuns.factoryId, factoryId),
              eq(factoryRuns.issueNumber, issueNumber),
              eq(factoryRuns.state, 'no_change'),
            ),
          )
          .limit(1),
        storage,
      ).map((rows) => rows.length > 0);
    },

    /** How many times an issue's run has failed — the retry cap. */
    failedCount(factoryId: string, issueNumber: number): ResultAsync<number, FactoryRunsError> {
      return ResultAsync.fromPromise(
        db
          .select({ id: factoryRuns.id })
          .from(factoryRuns)
          .where(
            and(
              eq(factoryRuns.factoryId, factoryId),
              eq(factoryRuns.issueNumber, issueNumber),
              eq(factoryRuns.state, 'failed'),
            ),
          ),
        storage,
      ).map((rows) => rows.length);
    },

    inFlight,

    /** How many runs hold a concurrency slot (see `inFlight`). */
    countActive(factoryId: string): ResultAsync<number, FactoryRunsError> {
      return inFlight(factoryId).map((rows) => rows.length);
    },

    /**
     * Record a labelled issue's run in flight (`queued`) when the factory has a
     * free slot (`withFreeSlot`); `NO_FREE_SLOT` otherwise. The unique index
     * refuses it while another run of the issue is open (a storage error).
     */
    startInFlight(
      input: Omit<StartRunInput, 'state'>,
    ): ResultAsync<FactoryRunView | typeof NO_FREE_SLOT, FactoryRunsError> {
      return withFreeSlot(input.factoryId, async () => {
        const started = await insertRun({ ...input, state: 'queued' });
        if (started.isErr()) throw new Error(started.error.message);
        return started.value;
      });
    },

    /**
     * Record a run as given, without checking the factory's capacity: for a
     * run that holds no slot. A run put in flight goes through `startInFlight`.
     */
    start: (input: StartRunInput) => insertRun(input),

    ...queueOperations(deps.newId),

    update(runId: string, input: UpdateRunInput): ResultAsync<void, FactoryRunsError> {
      const changes = changesFor(input);
      if (!changes) return okAsync(undefined);
      return ResultAsync.fromPromise(
        db.update(factoryRuns).set(changes).where(eq(factoryRuns.id, runId)),
        storage,
      )
        .andThen(() => afterStateWrite(runId, input, true))
        .map(() => undefined);
    },

    /**
     * Update a run only while it is still in `from` — so a late writer cannot
     * overwrite a transition another path already made (e.g. the launch marking
     * a run `working` after its thread already finished). Resolves whether the
     * run was in `from` and changed.
     */
    advance(
      runId: string,
      from: FactoryRunState,
      input: UpdateRunInput,
    ): ResultAsync<boolean, FactoryRunsError> {
      const changes = changesFor(input);
      if (!changes) return okAsync(false);
      return ResultAsync.fromPromise(
        db
          .update(factoryRuns)
          .set(changes)
          .where(and(eq(factoryRuns.id, runId), eq(factoryRuns.state, from)))
          .returning({ id: factoryRuns.id }),
        storage,
      )
        .map((rows) => rows.length > 0)
        .andThen((moved) => afterStateWrite(runId, input, moved));
    },

    /**
     * Move a run into its review or merge step: only from a state in which it
     * has a pull request and a flow driving it (`STAGE_TRANSITIONS`), a
     * compare-and-set. Resolves whether it moved; false for a run that was
     * stopped, parked or never opened a pull request.
     */
    enterStage(
      runId: string,
      stage: FactoryRunStage,
      input: Omit<UpdateRunInput, 'state'> = {},
    ): ResultAsync<boolean, FactoryRunsError> {
      const { from, to } = STAGE_TRANSITIONS[stage];
      const changes = changesFor({ ...input, state: to })!;
      return ResultAsync.fromPromise(
        db
          .update(factoryRuns)
          .set(changes)
          .where(and(eq(factoryRuns.id, runId), inArray(factoryRuns.state, [...from])))
          .returning({ id: factoryRuns.id }),
        storage,
      )
        .map((rows) => rows.length > 0)
        .andThen((moved) => afterStateWrite(runId, { state: to }, moved));
    },

    /**
     * Update a run unless it is already terminal (stopped, merged, failed), so
     * a flow still finishing cannot revive a run someone stopped. Resolves
     * whether the run was still in flight.
     */
    updateInFlight(runId: string, input: UpdateRunInput): ResultAsync<boolean, FactoryRunsError> {
      const changes = changesFor(input);
      if (!changes) return okAsync(true);
      return ResultAsync.fromPromise(
        db
          .update(factoryRuns)
          .set(changes)
          .where(
            and(eq(factoryRuns.id, runId), notInArray(factoryRuns.state, [...TERMINAL_STATES])),
          )
          .returning({ id: factoryRuns.id }),
        storage,
      )
        .map((rows) => rows.length > 0)
        .andThen((live) => afterStateWrite(runId, input, live));
    },

    /**
     * Close a parked run (failed, or waiting for the member) whose pull request
     * was merged or closed outside the factory: only from those states (a
     * compare-and-set), so a run retried meanwhile is left alone. Resolves
     * whether it closed.
     */
    closeParked(
      runId: string,
      outcome: 'merged' | 'closed',
    ): ResultAsync<boolean, FactoryRunsError> {
      const changes = changesFor(
        outcome === 'merged'
          ? { state: 'merged', currentStep: null, failureReason: null }
          : { state: 'stopped', failureReason: 'Its pull request was closed without a merge.' },
      )!;
      return updateFromParked(runId, changes).andThen((closed) =>
        afterStateWrite(runId, { state: changes.state as FactoryRunState }, closed),
      );
    },

    /** The parked runs of a factory that may still close by their pull request (`awaitsPullRequest`). */
    awaitingPullRequest(factoryId: string): ResultAsync<FactoryRunView[], FactoryRunsError> {
      return ResultAsync.fromPromise(
        db
          .select()
          .from(factoryRuns)
          .where(and(eq(factoryRuns.factoryId, factoryId), awaitsPullRequest())),
        storage,
      ).map((rows) => rows.map(toView));
    },

    /**
     * Record the pull request found on a parked run's branch (its flow had no
     * `create_pr` step), only while it is still parked: a compare-and-set.
     */
    recordParkedPr(runId: string, prUrl: string): ResultAsync<boolean, FactoryRunsError> {
      return updateFromParked(runId, { prUrl });
    },

    /**
     * The proof of a parked run's new head (re-proved while it waits on
     * auto-merge), and why it cannot merge, or null. Only while it is parked.
     */
    recordParkedProof(
      runId: string,
      proof: RegressionProofRecord,
      failureReason: string | null,
    ): ResultAsync<boolean, FactoryRunsError> {
      return updateFromParked(runId, { regressionProof: JSON.stringify(proof), failureReason });
    },

    /**
     * The runs of every factory merged since `since` whose pull request is in
     * `repo` (`owner/name`), newest first, with their enabler: what a broken
     * base branch may be traced to.
     */
    mergedSince(
      repo: string,
      since: string,
    ): ResultAsync<Array<FactoryRunView & { userId: string }>, FactoryRunsError> {
      return ResultAsync.fromPromise(
        db
          .select({ run: factoryRuns, userId: factorySettings.userId })
          .from(factoryRuns)
          .innerJoin(factorySettings, eq(factorySettings.id, factoryRuns.factoryId))
          .where(
            and(
              eq(factoryRuns.state, 'merged'),
              gte(factoryRuns.completedAt, since),
              // The repository is known in lowercase; GitHub's URL keeps its own case.
              like(
                sql`lower(${factoryRuns.prUrl})`,
                `https://github.com/${repo.toLowerCase()}/pull/%`,
              ),
            ),
          )
          .orderBy(desc(factoryRuns.completedAt)),
        storage,
      ).map((rows) => rows.map(({ run, userId }) => ({ ...toView(run), userId })));
    },

    /** One run by its id, or null. */
    get(runId: string): ResultAsync<FactoryRunView | null, FactoryRunsError> {
      return ResultAsync.fromPromise(
        db.select().from(factoryRuns).where(eq(factoryRuns.id, runId)),
        storage,
      ).map((rows) => (rows[0] ? toView(rows[0]) : null));
    },

    /** The parked or failed runs a thread belongs to (a member following up on it). */
    reopenableByThread(threadId: string): ResultAsync<FactoryRunView[], FactoryRunsError> {
      return ResultAsync.fromPromise(
        db
          .select()
          .from(factoryRuns)
          .where(
            and(
              inArray(factoryRuns.state, [...RETRYABLE_STATES]),
              // Narrowed in SQL (thread_ids is a JSON array); the exact match is below.
              like(factoryRuns.threadIds, `%${JSON.stringify(threadId)}%`),
            ),
          ),
        storage,
      ).map((rows) => rows.map(toView).filter((run) => run.threadIds.includes(threadId)));
    },

    /**
     * Put a failed or parked run back in flight (`queued`) with `threadIds` as
     * the steps to replay — a retry or a take-over — when its factory has a
     * free slot (`withFreeSlot`): `reopened`, `NO_FREE_SLOT`, or
     * `not-reopenable` when it was not failed nor parked. The unique index
     * refuses it while another run of the issue is in flight (a storage error).
     *
     * The run's journal is cleared: the reopened attempt replays `threadIds`
     * by call order (the steps the retry or take-over chose), then journals
     * its own executions for a resume after a restart.
     */
    reopen(
      run: Pick<FactoryRunView, 'id' | 'factoryId'>,
      threadIds: string[],
    ): ResultAsync<'reopened' | 'not-reopenable' | typeof NO_FREE_SLOT, FactoryRunsError> {
      return withFreeSlot(run.factoryId, async () => {
        const reopened = await updateFromParked(
          run.id,
          {
            state: 'queued',
            currentStep: REOPENED_STEP,
            completedAt: null,
            launchStartedAt: null,
            threadIds: JSON.stringify(threadIds),
            failureReason: null,
          },
          RETRYABLE_STATES,
        );
        if (reopened.isErr()) throw new Error(reopened.error.message);
        if (!reopened.value) return 'not-reopenable' as const;
        await db.delete(workflowNodeExecutions).where(eq(workflowNodeExecutions.runId, run.id));
        return 'reopened' as const;
      });
    },

    /** Drop a run that never started (its launch failed before any agent ran). */
    remove(runId: string): ResultAsync<void, FactoryRunsError> {
      return ResultAsync.fromPromise(
        db.delete(factoryRuns).where(eq(factoryRuns.id, runId)),
        storage,
      ).map(() => undefined);
    },

    /** Terminal-mark several runs at once (e.g. when a factory is disabled). */
    stopMany(runIds: string[]): ResultAsync<void, FactoryRunsError> {
      if (runIds.length === 0) return okAsync(undefined);
      return ResultAsync.fromPromise(
        db
          .update(factoryRuns)
          .set({ state: 'stopped', completedAt: new Date().toISOString() })
          .where(inArray(factoryRuns.id, runIds)),
        storage,
      ).map(() => undefined);
    },
  };
}
