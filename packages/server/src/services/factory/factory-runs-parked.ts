/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: application
 *
 * The factory runs repository's writes of parked runs (split out of
 * `factory-runs.ts`): closing, recording on and reopening a failed or parked
 * run, each a compare-and-set from the parked states.
 */
import { eq } from 'drizzle-orm';
import { okAsync, ResultAsync } from 'neverthrow';

import { db } from '../../db/index.js';
import { workflowNodeExecutions } from '../../db/schema.js';
import {
  storage,
  RETRYABLE_STATES,
  changesFor,
  REOPENED_STEP,
  type FactoryRunsError,
  type FactoryRunView,
  type FactoryRunState,
  type RegressionProofRecord,
} from './factory-runs-model.js';
import {
  updateFromParked,
  moveRun,
  NO_FREE_SLOT,
  withFreeSlot,
  headOfQueue,
  afterStateWrite,
} from './factory-runs-writes.js';

/** The repository's writes of parked (failed, or waiting for the member) runs. */
export function parkedOperations() {
  return {
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
      const state: FactoryRunState = outcome === 'merged' ? 'merged' : 'stopped';
      const changes = changesFor(
        outcome === 'merged'
          ? { state, currentStep: null, failureReason: null }
          : { state, failureReason: 'Its pull request was closed without a merge.' },
      )!;
      return updateFromParked(runId, changes).andThen((closed) =>
        afterStateWrite(runId, { state }, closed),
      );
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
     * Put a failed or parked run back in flight (`queued`) with `threadIds` as
     * the steps to replay — a retry or a take-over — when its factory has a
     * free slot (`withFreeSlot`): `reopened`. Without a free slot it goes to
     * the head of the queue instead (`queued`: `requested` with the wait
     * reason `no-free-slot`, the same steps to replay), and the watcher admits
     * it when a slot frees. `not-reopenable` when it was not failed nor
     * parked. The unique index refuses it while another run of the issue is
     * in flight (a storage error).
     *
     * The run's journal is cleared: the reopened attempt replays `threadIds`
     * by call order (the steps the retry or take-over chose), then journals
     * its own executions for a resume after a restart.
     */
    reopen(
      run: Pick<FactoryRunView, 'id' | 'factoryId'>,
      threadIds: string[],
    ): ResultAsync<'reopened' | 'queued' | 'not-reopenable', FactoryRunsError> {
      const reopening = {
        // Marks a run with a history: a flow that cannot start again fails it, never drops it.
        currentStep: REOPENED_STEP,
        completedAt: null,
        launchStartedAt: null,
        threadIds: JSON.stringify(threadIds),
        failureReason: null,
      };
      const clearJournal = () =>
        db.delete(workflowNodeExecutions).where(eq(workflowNodeExecutions.runId, run.id));
      return withFreeSlot(run.factoryId, async () => {
        const reopened = await updateFromParked(
          run.id,
          { state: 'queued', ...reopening },
          RETRYABLE_STATES,
        );
        if (reopened.isErr()) throw new Error(reopened.error.message);
        if (!reopened.value) return 'not-reopenable' as const;
        await clearJournal();
        return 'reopened' as const;
      }).andThen((outcome) =>
        outcome !== NO_FREE_SLOT
          ? okAsync(outcome)
          : ResultAsync.fromPromise(headOfQueue(run.factoryId), storage)
              .andThen((queueOrder) =>
                moveRun(run.id, 'reopenQueued', {
                  ...reopening,
                  admittedAt: null,
                  queueOrder,
                  waitReason: JSON.stringify({ kind: 'no-free-slot', blockers: [] }),
                }),
              )
              .andThen((moved) =>
                moved
                  ? ResultAsync.fromPromise(clearJournal(), storage).map(() => 'queued' as const)
                  : okAsync('not-reopenable' as const),
              ),
      );
    },
  };
}
