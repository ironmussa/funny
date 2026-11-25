/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: application
 *
 * The compare-and-set writes the factory runs repository is built from (split
 * out of `factory-runs.ts`): moves from parked or queued states, the
 * concurrency slot check, flow state writes and queue positions.
 */
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  notInArray,
  sql,
  type SQL,
} from 'drizzle-orm';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import { db, dbDialect, withDatabaseTransaction } from '../../db/index.js';
import { factoryRuns, factorySettings } from '../../db/schema.js';
import {
  storage,
  TERMINAL_STATES,
  TERMINAL,
  REOPENABLE_STATES,
  QUEUE_TRANSITIONS,
  FLOW_TRANSITIONS,
  IN_FLIGHT_STATES,
  type Row,
  type FactoryRunsError,
  type FactoryRunState,
  type FactoryFlowState,
  type UpdateRunInput,
} from './factory-runs-model.js';
import { syncRunThreadStages } from './factory-thread-stage.js';

/**
 * Write `changes` to a run only while it is parked (failed, or waiting for the
 * member): a compare-and-set. Resolves whether it was parked.
 */
export function updateFromParked(
  runId: string,
  changes: Partial<Row>,
  from: readonly FactoryRunState[] = REOPENABLE_STATES,
): ResultAsync<boolean, FactoryRunsError> {
  return updateFrom(runId, changes, from);
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
  return updateFrom(runId, { ...changes, state: to }, from);
}

/**
 * Write `changes` to one run only while its stored state is one of `from` (a
 * compare-and-set). Resolves whether the run was written.
 */
export function updateFrom(
  runId: string,
  changes: Partial<Row>,
  from: readonly FactoryRunState[],
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

/** Write `changes` on a run that has not ended; resolves whether it was still live. */
export function writeLiveRun(
  runId: string,
  changes: Partial<Row>,
): ResultAsync<boolean, FactoryRunsError> {
  return ResultAsync.fromPromise(
    db
      .update(factoryRuns)
      .set(changes)
      .where(and(eq(factoryRuns.id, runId), notInArray(factoryRuns.state, [...TERMINAL_STATES])))
      .returning({ id: factoryRuns.id }),
    storage,
  ).map((rows) => rows.length > 0);
}

/** Write a flow's new state `to` only from the states it leads from: a compare-and-set. */
export function writeAlongFlow(
  runId: string,
  to: FactoryFlowState,
  changes: Partial<Row>,
): ResultAsync<boolean, FactoryRunsError> {
  return ResultAsync.fromPromise(
    db
      .update(factoryRuns)
      .set(changes)
      .where(and(eq(factoryRuns.id, runId), inArray(factoryRuns.state, [...FLOW_TRANSITIONS[to]])))
      .returning({ id: factoryRuns.id }),
    storage,
  ).map((rows) => rows.length > 0);
}

/**
 * Why a flow's write of `to` changed nothing: the run ended (or is gone),
 * `false` as before; or it is live in a state that does not lead to `to`.
 */
export function refusedFlowWrite(
  runId: string,
  to: FactoryFlowState,
): ResultAsync<boolean, FactoryRunsError> {
  return ResultAsync.fromPromise(
    db.select({ state: factoryRuns.state }).from(factoryRuns).where(eq(factoryRuns.id, runId)),
    storage,
  ).andThen((rows) => {
    // SAFETY: `state` is written only from `FactoryRunState` values (the transitions above).
    const from = rows[0]?.state as FactoryRunState | undefined;
    if (from === undefined || TERMINAL.has(from)) return okAsync(false);
    return errAsync<boolean, FactoryRunsError>({
      kind: 'illegal-transition',
      message: `A factory run in ${from} cannot move to ${to}.`,
      from,
      to,
    });
  });
}

/** The position behind the factory's queue. */
export async function nextQueueOrder(factoryId: string): Promise<number> {
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
 * After a write that set the run's `state`, move its threads' kanban stage to
 * match (`syncRunThreadStages`, which reads the stored state). Passes `wrote`
 * through; a sync failure is logged there and never fails the write.
 */
export function afterStateWrite(
  runId: string,
  input: Pick<UpdateRunInput, 'state'>,
  wrote: boolean,
): ResultAsync<boolean, FactoryRunsError> {
  if (!wrote || input.state === undefined) return okAsync(wrote);
  return syncRunThreadStages(runId).map(() => wrote);
}
