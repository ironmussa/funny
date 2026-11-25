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
 * Leaving the queue is a compare-and-set (`QUEUE_TRANSITIONS`), and so is
 * every state a flow writes after that (`FLOW_TRANSITIONS`, `STAGE_TRANSITIONS`):
 * no method writes a run's state by its id alone.
 */
import type { FactoryRiskWaiver } from '@funny/shared/contracts/factory';
import { and, eq, inArray } from 'drizzle-orm';
import { okAsync, ResultAsync } from 'neverthrow';

import { db } from '../../db/index.js';
import { factoryRuns } from '../../db/schema.js';
import { mergeApprovalOperations } from './factory-runs-approvals.js';
import {
  changesFor,
  newRunRow,
  NO_ISSUE,
  STAGE_TRANSITIONS,
  storage,
  toView,
  triggerFieldsOf,
  type FactoryRunsError,
  type FactoryRunStage,
  type FactoryRunView,
  type StartRunInput,
  type UpdateRunInput,
} from './factory-runs-model.js';
import { parkedOperations } from './factory-runs-parked.js';
import { queueOperations } from './factory-runs-queue.js';
import { inFlight, runReadOperations } from './factory-runs-reads.js';
import {
  afterStateWrite,
  NO_FREE_SLOT,
  refusedFlowWrite,
  withFreeSlot,
  writeAlongFlow,
  writeLiveRun,
} from './factory-runs-writes.js';

export {
  awaitsPullRequest,
  factoryRunBranch,
  factoryRunLabel,
  flowTransitionFrom,
  HIGH_RISK_HOLD,
  IN_FLIGHT_STATES,
  parseStoredInputs,
  REOPENED_STEP,
  threadsOf,
  withReviewVerdict,
  type FactoryFlowState,
  type FactoryRunSource,
  type FactoryRunsError,
  type FactoryRunStage,
  type FactoryRunState,
  type FactoryRunView,
  type RegressionProofRecord,
  type StartRunInput,
  type UpdateRunInput,
} from './factory-runs-model.js';
export { NO_FREE_SLOT } from './factory-runs-writes.js';

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
    ...runReadOperations(),

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

    /**
     * Record fields that are not the run's state, whatever the state is (the
     * run it is stacked on). A state is written only along a transition:
     * `updateInFlight`, `enterStage` or a queue transition.
     */
    update(
      runId: string,
      input: Omit<UpdateRunInput, 'state'>,
    ): ResultAsync<void, FactoryRunsError> {
      const changes = changesFor(input);
      if (!changes) return okAsync(undefined);
      return ResultAsync.fromPromise(
        db.update(factoryRuns).set(changes).where(eq(factoryRuns.id, runId)),
        storage,
      ).map(() => undefined);
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
     * a flow still finishing cannot revive a run someone stopped. A new state
     * is written only from the stored states `FLOW_TRANSITIONS` allows, a
     * compare-and-set. Resolves whether the run was still live; a live run
     * whose state does not lead to the new one changes nothing and fails with
     * `illegal-transition`.
     */
    updateInFlight(runId: string, input: UpdateRunInput): ResultAsync<boolean, FactoryRunsError> {
      const changes = changesFor(input);
      if (!changes) return okAsync(true);
      const to = input.state;
      if (to === undefined) return writeLiveRun(runId, changes);
      return writeAlongFlow(runId, to, changes).andThen((moved) =>
        moved ? afterStateWrite(runId, input, true) : refusedFlowWrite(runId, to),
      );
    },

    ...parkedOperations(),

    /**
     * Record (or, with null, remove) a member's statement that the run is a
     * lint cleanup. Refused for a run that ended: nothing would read it.
     * Resolves whether it was written.
     */
    setRiskWaiver(
      runId: string,
      waiver: FactoryRiskWaiver | null,
    ): ResultAsync<boolean, FactoryRunsError> {
      return writeLiveRun(runId, { riskWaiver: waiver ? JSON.stringify(waiver) : null });
    },

    /**
     * A member agreed there is nothing to change: the `no_change` run becomes
     * `done`. A compare-and-set on the stored state; resolves whether it was
     * still `no_change`.
     */
    markDone(runId: string): ResultAsync<boolean, FactoryRunsError> {
      return ResultAsync.fromPromise(
        db
          .update(factoryRuns)
          .set({ state: 'done', waitReason: null })
          .where(and(eq(factoryRuns.id, runId), eq(factoryRuns.state, 'no_change')))
          .returning({ id: factoryRuns.id }),
        storage,
      ).map((rows) => rows.length > 0);
    },

    ...mergeApprovalOperations(),

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
