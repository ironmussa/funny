/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: application
 *
 * The factory runs' queue (change factory-manual-queue) and the writes that
 * take a concurrency slot: new run rows, compare-and-set moves along
 * `QUEUE_TRANSITIONS`, and `withFreeSlot`. Part of the factory runs
 * repository (`factory-runs.ts`).
 */
import type { FactoryWaitReason } from '@funny/shared/contracts/factory';
import { and, asc, count, desc, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import { ResultAsync } from 'neverthrow';

import { db, dbDialect, withDatabaseTransaction } from '../../db/index.js';
import { factoryRuns, factorySettings } from '../../db/schema.js';
import {
  IN_FLIGHT_STATES,
  NO_ISSUE,
  QUEUE_TRANSITIONS,
  REOPENABLE_STATES,
  storage,
  toView,
  type FactoryRunState,
  type FactoryRunsError,
  type FactoryRunView,
  type Row,
} from './factory-runs-model.js';

/**
 * Write `changes` to a run only while it is parked (failed, or waiting for the
 * member): a compare-and-set. Resolves whether it was parked.
 */
export function updateFromParked(
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
export function moveRun(
  runId: string,
  transition: keyof typeof QUEUE_TRANSITIONS,
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
export function withFreeSlot<T>(
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

/** The position behind the factory's queue. */
async function nextQueueOrder(factoryId: string): Promise<number> {
  const [last] = await db
    .select({ order: factoryRuns.queueOrder })
    .from(factoryRuns)
    .where(eq(factoryRuns.factoryId, factoryId))
    .orderBy(desc(factoryRuns.queueOrder))
    .limit(1);
  return (last?.order ?? 0) + 1;
}

/** A queue order ahead of every run of the factory: a reopened run goes first. */
export async function headOfQueue(factoryId: string): Promise<number> {
  const [first] = await db
    .select({ order: factoryRuns.queueOrder })
    .from(factoryRuns)
    .where(and(eq(factoryRuns.factoryId, factoryId), isNotNull(factoryRuns.queueOrder)))
    .orderBy(asc(factoryRuns.queueOrder))
    .limit(1);
  return Math.min(first?.order ?? 1, 1) - 1;
}

/**
 * The queue's reads and writes (change factory-manual-queue): sent issues wait
 * in `requested` until the watcher admits them; each move out of the queue is
 * a compare-and-set from the stored state (`QUEUE_TRANSITIONS`).
 */
export function queueOperations(newId: () => string) {
  return {
    /**
     * Queue issues (sent from funny, or found by their label), in the given order, behind the factory's queue, in one
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
      /** `label`: an issue the watcher found by its label (automatic mode); default `manual`. */
      source?: 'manual' | 'label';
    }): ResultAsync<{ queued: FactoryRunView[]; duplicates: number[] }, FactoryRunsError> {
      return ResultAsync.fromPromise(
        (async () => {
          const first = await nextQueueOrder(input.factoryId);
          const now = new Date().toISOString();
          const rows: Row[] = input.issueNumbers.map((issueNumber, index) =>
            newRunRow({
              id: newId(),
              factoryId: input.factoryId,
              issueNumber,
              state: 'requested',
              startedAt: now,
              source: input.source ?? 'manual',
              flowName: input.flowName,
              queueOrder: first + index,
            }),
          );
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

    /**
     * Queue one run without an issue (change flow-triggers), behind the
     * factory's queue. Null when its schedule trigger still has a run working:
     * the one-run-per-trigger index refuses the row.
     */
    enqueueIssueless(input: {
      factoryId: string;
      flowName: string;
      source: 'schedule' | 'run_now';
      trigger?: { id: string; name: string };
      inputs: Record<string, string>;
    }): ResultAsync<FactoryRunView | null, FactoryRunsError> {
      return ResultAsync.fromPromise(
        (async () => {
          const row = newRunRow({
            id: newId(),
            factoryId: input.factoryId,
            issueNumber: NO_ISSUE,
            state: 'requested',
            source: input.source,
            flowName: input.flowName,
            queueOrder: await nextQueueOrder(input.factoryId),
            ...triggerFieldsOf(input),
          });
          const written = await db
            .insert(factoryRuns)
            .values(row)
            .onConflictDoNothing()
            .returning({ id: factoryRuns.id });
          return written.length > 0 ? toView(row) : null;
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
