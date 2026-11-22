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
  type FactoryRegressionProof,
  type FactoryRunMetrics,
  type FactoryWaitReason,
} from '@funny/shared/contracts/factory';
import { parseStoredJson } from '@funny/shared/json-validation';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  like,
  notInArray,
  or,
  type SQL,
} from 'drizzle-orm';
import { okAsync, ResultAsync } from 'neverthrow';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { factoryRuns, factorySettings, workflowNodeExecutions } from '../../db/schema.js';

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
  ]),
  blockers: z.array(z.number().int()),
});

/** States a run moves through; non-terminal ones block re-admitting the issue. */
export type FactoryRunState =
  | 'requested'
  | 'queued'
  | 'working'
  | 'pr_open'
  | 'waiting_ci'
  | 'fixing'
  | 'waiting_human'
  | 'merged'
  | 'failed'
  | 'stopped';

const TERMINAL_STATES = ['merged', 'failed', 'stopped'] as const satisfies FactoryRunState[];
const TERMINAL: ReadonlySet<FactoryRunState> = new Set(TERMINAL_STATES);

/**
 * Non-terminal states that do NOT hold a concurrency slot: the agent is done and
 * the run waits for a person. It still blocks re-admitting its issue.
 */
const PARKED_STATES = ['waiting_human'] as const satisfies FactoryRunState[];

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
} as const satisfies Record<string, { from: readonly FactoryRunState[]; to: FactoryRunState }>;

/** States in which a flow is driving the run: neither terminal, parked nor waiting. */
export const IN_FLIGHT_STATES = [
  'queued',
  'working',
  'pr_open',
  'waiting_ci',
  'fixing',
] as const satisfies FactoryRunState[];

/**
 * The `currentStep` of a run a retry or take-over put back in flight, until its
 * flow enters a step: such a run has a history, so a flow that cannot start
 * again marks it failed instead of dropping it as never started.
 */
export const REOPENED_STEP = 'retrying';

/** States a run can be retried or taken over from. */
const REOPENABLE_STATES = ['failed', 'waiting_human'] as const satisfies FactoryRunState[];

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
}

export type FactoryRunSource = 'manual' | 'label';

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
});

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
}

/** Update fields stored as they are, and the ones stored as JSON. */
const PLAIN_FIELDS = ['currentStep', 'prUrl', 'launchStartedAt', 'failureReason'] as const;
const JSON_FIELDS = ['threadIds', 'flowSteps', 'metrics', 'regressionProof'] as const;

function changesFor(input: UpdateRunInput): Partial<Row> | null {
  const changes: Partial<Row> = {};
  if (input.state !== undefined) {
    changes.state = input.state;
    // A parked run's flow ended too: when it parked is when a take-over may follow.
    if (TERMINAL.has(input.state) || input.state === 'waiting_human') {
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
): ResultAsync<boolean, FactoryRunsError> {
  return ResultAsync.fromPromise(
    db
      .update(factoryRuns)
      .set(changes)
      .where(and(eq(factoryRuns.id, runId), inArray(factoryRuns.state, [...REOPENABLE_STATES])))
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
  transition: 'admit' | 'requeue',
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

    /** `requested → queued`; false when the run left the queue meanwhile (cancelled). */
    admit: (runId: string) =>
      moveRun(runId, 'admit', { admittedAt: new Date().toISOString(), waitReason: null }),

    /** `queued → requested`, keeping its place: its flow could not start any agent. */
    requeue: (runId: string) =>
      moveRun(runId, 'requeue', {
        admittedAt: null,
        currentStep: null,
        launchStartedAt: null,
        failureReason: null,
      }),

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
     * not ended (queued, in flight, or waiting for the member), or failed within
     * `FAILED_RUN_WINDOW_MS`, with the project its factory belongs to.
     */
    queueForOwner(
      userId: string,
      now: number = Date.now(),
    ): ResultAsync<Array<FactoryRunView & { projectId: string }>, FactoryRunsError> {
      const failedSince = new Date(now - FAILED_RUN_WINDOW_MS).toISOString();
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
                and(eq(factoryRuns.state, 'failed'), gte(factoryRuns.completedAt, failedSince)),
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

    start(input: StartRunInput): ResultAsync<FactoryRunView, FactoryRunsError> {
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
      };
      return ResultAsync.fromPromise(db.insert(factoryRuns).values(row), storage).map(() =>
        toView(row),
      );
    },

    ...queueOperations(deps.newId),

    update(runId: string, input: UpdateRunInput): ResultAsync<void, FactoryRunsError> {
      const changes = changesFor(input);
      if (!changes) return okAsync(undefined);
      return ResultAsync.fromPromise(
        db.update(factoryRuns).set(changes).where(eq(factoryRuns.id, runId)),
        storage,
      ).map(() => undefined);
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
      ).map((rows) => rows.length > 0);
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
      ).map((rows) => rows.length > 0);
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
      return updateFromParked(runId, changes);
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
              inArray(factoryRuns.state, [...REOPENABLE_STATES]),
              // Narrowed in SQL (thread_ids is a JSON array); the exact match is below.
              like(factoryRuns.threadIds, `%${JSON.stringify(threadId)}%`),
            ),
          ),
        storage,
      ).map((rows) => rows.map(toView).filter((run) => run.threadIds.includes(threadId)));
    },

    /**
     * Put a failed or parked run back in flight (`queued`) with `threadIds` as
     * the steps to replay — a retry or a take-over. Resolves whether it was
     * reopenable; the unique index refuses it while another run of the issue
     * is in flight (a storage error).
     *
     * The run's journal is cleared: the reopened attempt replays `threadIds`
     * by call order (the steps the retry or take-over chose), then journals
     * its own executions for a resume after a restart.
     */
    reopen(runId: string, threadIds: string[]): ResultAsync<boolean, FactoryRunsError> {
      return updateFromParked(runId, {
        state: 'queued',
        currentStep: REOPENED_STEP,
        completedAt: null,
        launchStartedAt: null,
        threadIds: JSON.stringify(threadIds),
        failureReason: null,
      }).andThen((reopened) =>
        reopened
          ? ResultAsync.fromPromise(
              db.delete(workflowNodeExecutions).where(eq(workflowNodeExecutions.runId, runId)),
              storage,
            ).map(() => true)
          : okAsync(false),
      );
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
