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
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { okAsync, ResultAsync } from 'neverthrow';

import { db } from '../../db/index.js';
import { factoryRuns } from '../../db/schema.js';
import {
  changesFor,
  NO_ISSUE,
  STAGE_TRANSITIONS,
  storage,
  TERMINAL_STATES,
  toView,
  type FactoryRunStage,
  type FactoryRunState,
  type FactoryRunsError,
  type FactoryRunView,
  type StartRunInput,
  type UpdateRunInput,
} from './factory-runs-model.js';
import { afterStateWrite, parkedRunWrites } from './factory-runs-parked.js';
import {
  NO_FREE_SLOT,
  newRunRow,
  queueOperations,
  triggerFieldsOf,
  withFreeSlot,
} from './factory-runs-queue.js';
import { runReads } from './factory-runs-reads.js';

export {
  awaitsPullRequest,
  factoryRunBranch,
  factoryRunLabel,
  HIGH_RISK_HOLD,
  IN_FLIGHT_STATES,
  parseStoredInputs,
  REOPENED_STEP,
  threadsOf,
  withReviewVerdict,
  type FactoryRunStage,
  type FactoryRunState,
  type FactoryRunsError,
  type FactoryRunView,
  type RegressionProofRecord,
  type StartRunInput,
  type UpdateRunInput,
} from './factory-runs-model.js';
export { NO_FREE_SLOT } from './factory-runs-queue.js';

export function createFactoryRunsRepository(
  deps: { newId: () => string } = { newId: () => crypto.randomUUID() },
) {
  /** Insert a run row as given. */
  const insertRun = (input: StartRunInput): ResultAsync<FactoryRunView, FactoryRunsError> => {
    const state = input.state ?? 'queued';
    const row = newRunRow({
      id: deps.newId(),
      factoryId: input.factoryId,
      issueNumber: input.issueNumber ?? NO_ISSUE,
      state,
      currentStep: input.currentStep ?? null,
      threadIds: JSON.stringify(input.threadIds ?? []),
      source: input.source ?? 'label',
      flowName: input.flowName ?? null,
      admittedAt: state === 'requested' ? null : new Date().toISOString(),
      ...triggerFieldsOf(input),
    });
    return ResultAsync.fromPromise(db.insert(factoryRuns).values(row), storage).map(() =>
      toView(row),
    );
  };

  return {
    ...runReads(),

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

    ...parkedRunWrites(),
  };
}
