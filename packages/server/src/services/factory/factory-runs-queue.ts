/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: application
 *
 * The factory runs queue (change factory-manual-queue), split out of
 * `factory-runs.ts`.
 */
import {
  type FactoryRunHold,
  type FactoryTriage,
  type FactoryWaitReason,
} from '@funny/shared/contracts/factory';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { okAsync, ResultAsync } from 'neverthrow';

import { db } from '../../db/index.js';
import { factoryRuns, workflowNodeExecutions } from '../../db/schema.js';
import {
  storage,
  toView,
  QUEUE_TRANSITIONS,
  NO_ISSUE,
  newRunRow,
  REOPENED_STEP,
  triggerFieldsOf,
  type Row,
  type FactoryRunsError,
  type FactoryRunView,
} from './factory-runs-model.js';
import { moveRun, NO_FREE_SLOT, withFreeSlot, nextQueueOrder } from './factory-runs-writes.js';

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
      /** The titles of those issues the caller read, by number. */
      issueTitles?: ReadonlyMap<number, string>;
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
              issueTitle: input.issueTitles?.get(issueNumber) ?? null,
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
      /**
       * The branch the run starts from and merges into (change factory-lanes,
       * D2). Recorded with the admission, and only the first time: a run sent
       * back to the queue and admitted again keeps the branch it had.
       */
      base: { branch: string | null; lane?: string | null } = { branch: null },
    ): ResultAsync<'admitted' | 'gone' | typeof NO_FREE_SLOT, FactoryRunsError> =>
      withFreeSlot(factoryId, async () => {
        const moved = await moveRun(runId, 'admit', {
          admittedAt: new Date().toISOString(),
          waitReason: null,
        });
        if (moved.isErr()) throw new Error(moved.error.message);
        if (!moved.value) return 'gone' as const;
        if (base.branch) {
          await db
            .update(factoryRuns)
            .set({ baseBranch: base.branch, lane: base.lane ?? null })
            .where(and(eq(factoryRuns.id, runId), isNull(factoryRuns.baseBranch)));
        }
        return 'admitted' as const;
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

    /**
     * A member split a run parked as too large: it ends `done`, with the
     * issues its parts were opened as. A compare-and-set from `needs_info`:
     * false when the run moved meanwhile (its issue changed and it went back
     * to triage, say).
     */
    markSplit: (runId: string, triage: FactoryTriage) =>
      moveRun(runId, 'split', {
        currentStep: null,
        failureReason: null,
        waitReason: null,
        completedAt: new Date().toISOString(),
        triage: JSON.stringify(triage),
      }),

    /**
     * A member put the run on hold (`putOnHold`): from a state where it waits
     * for a person or ended without merging, a compare-and-set. False when
     * it moved meanwhile. A run that ended with its issue already taken
     * again by a newer run is refused by the one-run-per-issue index (a
     * storage error).
     */
    putOnHold: (runId: string, hold: FactoryRunHold) =>
      moveRun(runId, 'putOnHold', {
        launchStartedAt: null,
        waitReason: null,
        completedAt: new Date().toISOString(),
        hold: JSON.stringify(hold),
      }),

    /**
     * A member released a run on hold (`release`): it goes to the back of the
     * queue, with `threadIds` as the steps it keeps (as a retry would), and
     * triage runs again on a new thread. Its journal is cleared, as on a
     * reopen. The hold stays recorded (the board shows it was held). False
     * when the run was not on hold.
     */
    release: (run: Pick<FactoryRunView, 'id' | 'factoryId' | 'triage'>, threadIds: string[]) =>
      ResultAsync.fromPromise(nextQueueOrder(run.factoryId), storage)
        .andThen((queueOrder) =>
          moveRun(run.id, 'release', {
            queueOrder,
            admittedAt: null,
            completedAt: null,
            launchStartedAt: null,
            failureReason: null,
            waitReason: null,
            currentStep: threadIds.length > 0 ? REOPENED_STEP : null,
            threadIds: JSON.stringify(threadIds),
            triage: run.triage ? JSON.stringify({ ...run.triage, superseded: true }) : null,
          }),
        )
        .andThen((moved) =>
          moved
            ? ResultAsync.fromPromise(
                db.delete(workflowNodeExecutions).where(eq(workflowNodeExecutions.runId, run.id)),
                storage,
              ).map(() => true)
            : okAsync(false),
        ),

    /** Record the parts opened so far, while the run is still parked (resumable). */
    recordSplitProgress: (runId: string, triage: FactoryTriage) =>
      ResultAsync.fromPromise(
        db
          .update(factoryRuns)
          .set({ triage: JSON.stringify(triage) })
          .where(and(eq(factoryRuns.id, runId), eq(factoryRuns.state, 'needs_info')))
          .returning({ id: factoryRuns.id }),
        storage,
      ).map((rows) => rows.length > 0),

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
