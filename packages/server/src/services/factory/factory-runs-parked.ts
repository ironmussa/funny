/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: application
 *
 * The factory runs repository's writes on a parked run (`factory-runs.ts`):
 * closing it by its pull request, recording its pull request and proof, a
 * member's merge approval, and putting it back in flight (`reopen`).
 */
import type { FactoryMergeApproval } from '@funny/shared/contracts/factory';
import { and, eq } from 'drizzle-orm';
import { okAsync, ResultAsync } from 'neverthrow';

import { db } from '../../db/index.js';
import { factoryRuns, workflowNodeExecutions } from '../../db/schema.js';
import {
  changesFor,
  HIGH_RISK_HOLD,
  parseMergeApproval,
  REOPENED_STEP,
  RETRYABLE_STATES,
  storage,
  type FactoryRunsError,
  type FactoryRunState,
  type FactoryRunView,
  type RegressionProofRecord,
  type UpdateRunInput,
} from './factory-runs-model.js';
import {
  headOfQueue,
  moveRun,
  NO_FREE_SLOT,
  updateFromParked,
  withFreeSlot,
} from './factory-runs-queue.js';
import { syncRunThreadStages } from './factory-thread-stage.js';

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

/** The repository's writes on a parked run (`createFactoryRunsRepository`). */
export function parkedRunWrites() {
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
      const changes = changesFor(
        outcome === 'merged'
          ? { state: 'merged', currentStep: null, failureReason: null }
          : { state: 'stopped', failureReason: 'Its pull request was closed without a merge.' },
      )!;
      return updateFromParked(runId, changes).andThen((closed) =>
        afterStateWrite(runId, { state: changes.state as FactoryRunState }, closed),
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
     * Record a member's approval to merge the run's held high-risk commit:
     * only while the run waits for a person because of that risk (a
     * compare-and-set on the stored state and reason). Resolves whether it
     * was written.
     */
    approveMerge(
      runId: string,
      approval: FactoryMergeApproval,
    ): ResultAsync<boolean, FactoryRunsError> {
      return ResultAsync.fromPromise(
        db
          .update(factoryRuns)
          .set({ mergeApproval: JSON.stringify(approval) })
          .where(
            and(
              eq(factoryRuns.id, runId),
              eq(factoryRuns.state, 'waiting_human'),
              eq(factoryRuns.failureReason, HIGH_RISK_HOLD),
            ),
          )
          .returning({ id: factoryRuns.id }),
        storage,
      ).map((rows) => rows.length > 0);
    },

    /**
     * Move the run's merge approval of `from` to `to`, a merge of `from` with
     * the base branch that settled nothing (the caller verified that). Nothing
     * happens unless the stored approval is of `from`: a compare-and-set on the
     * stored value, so a new approval written meanwhile is kept. Resolves
     * whether it moved.
     */
    carryMergeApproval(
      runId: string,
      from: string,
      to: string,
    ): ResultAsync<boolean, FactoryRunsError> {
      return ResultAsync.fromPromise(
        db
          .select({ mergeApproval: factoryRuns.mergeApproval })
          .from(factoryRuns)
          .where(eq(factoryRuns.id, runId)),
        storage,
      ).andThen((rows) => {
        const stored = rows[0]?.mergeApproval ?? null;
        const approval = parseMergeApproval(stored);
        if (!stored || approval?.sha !== from) return okAsync(false);
        const carried: FactoryMergeApproval = {
          ...approval,
          sha: to,
          carriedFrom: approval.carriedFrom ?? from,
        };
        return ResultAsync.fromPromise(
          db
            .update(factoryRuns)
            .set({ mergeApproval: JSON.stringify(carried) })
            .where(and(eq(factoryRuns.id, runId), eq(factoryRuns.mergeApproval, stored)))
            .returning({ id: factoryRuns.id }),
          storage,
        ).map((updated) => updated.length > 0);
      });
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
