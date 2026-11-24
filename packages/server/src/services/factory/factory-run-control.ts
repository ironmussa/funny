/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 *
 * A member's controls over their factory's runs (issue-factory phase 4):
 *
 * - **Stop** a run: it becomes `stopped`, its flow stops in this process and
 *   its running agent threads are stopped on the enabler's runner. A run the
 *   factory took by its label has the label taken off its issue, so automatic
 *   mode does not take it again.
 * - **Retry** a failed or parked run: it goes back in flight on the same
 *   branch and pull request, when the factory has a free slot (`maxConcurrent`,
 *   checked in the same step as the write; refused otherwise). A completed implement step is kept (its thread
 *   replays); every later step runs again, so a CI fix loop gets its fixes
 *   back. A "no change" run keeps nothing: a new agent implements the issue.
 *   The threads a retry does not keep are archived, so the list does not
 *   show the old failed thread next to the new one with the same title.
 * - **Approve the merge** of a run held because its change is high risk: the
 *   member's approval of that head commit is recorded, and the run is retried.
 *   The merge gate lets only the approved commit through, so a later push
 *   needs a new approval; every other gate (review, proof, CI) still applies.
 * - **Take over** a run: a member follows up on the run's last agent thread;
 *   when that thread completes again, a failed or parked run goes back in
 *   flight with all its steps replayed, so the flow continues from that step
 *   with the member's input (`onFactoryThreadTerminal`).
 *
 * The caller (the tRPC port) has checked `steer` and that the factory is
 * theirs; here a run must belong to that factory.
 */

import { implementingThreadOf } from '@funny/shared/contracts/factory';
import { and, eq, inArray } from 'drizzle-orm';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import { db } from '../../db/index.js';
import { threads } from '../../db/schema.js';
import { log } from '../../lib/logger.js';
import { NO_CHANGE_REASON } from './factory-action-provider.js';
import { forgetOwnerFollowUp, ownerFollowUpAt } from './factory-follow-ups.js';
import {
  createFactoryRunsRepository,
  HIGH_RISK_HOLD,
  NO_FREE_SLOT,
  threadsOf,
  type FactoryRunView,
} from './factory-runs.js';
import { getWatchedFactory } from './factory-settings.js';
import { archiveReplacedFactoryThreads, stopFactoryThreads } from './factory-thread-requests.js';
import { signalThreadTerminal } from './factory-thread-waits.js';
import {
  checkFactoryTarget,
  factoryBrowserEvents,
  factoryGithubPort,
  factoryRunnerPorts,
  pokeFactory,
  stopFactoryFlow,
} from './factory-watcher.js';

export type FactoryRunControlError = {
  kind: 'not-found' | 'conflict' | 'storage';
  message: string;
};

const notFound: FactoryRunControlError = { kind: 'not-found', message: 'Run not found' };
const storage = (error: { message: string }): FactoryRunControlError => ({
  kind: 'storage',
  message: error.message,
});

/** Look at the factory now; the request does not wait for the tick. */
function wake(factoryId: string): void {
  void pokeFactory(factoryId).catch((error: unknown) =>
    log.error('Issue factory poke failed', {
      namespace: 'factory',
      factoryId,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

/**
 * A stopped run that the factory took by its label: take the label off the
 * issue, so automatic mode does not admit it again at the next poll. A person
 * who wants it run again puts the label back (or retries the run). Best
 * effort: the stop has happened either way, and a failure is logged.
 */
async function releaseStoppedIssue(run: FactoryRunView): Promise<void> {
  if (run.source !== 'label' || run.issueNumber === null) return;
  const factory = await getWatchedFactory(run.factoryId);
  const port = factoryGithubPort();
  if (!factory?.label || !port) return;
  const target = await checkFactoryTarget(factory);
  if (!target || 'reason' in target) return;
  const reader = { repo: target.repo, ownerId: factory.userId, projectId: factory.projectId };
  const removed = await port.relabelIssue(reader, run.issueNumber, { remove: factory.label });
  if (removed.isErr()) {
    log.warn("Issue factory could not take the label off a stopped run's issue", {
      namespace: 'factory',
      runId: run.id,
      issue: run.issueNumber,
      error: removed.error.message,
    });
  }
}

/** A reopen the unique index refused: another run of the issue is in flight. */
function reopenRefused(error: { message: string }): FactoryRunControlError {
  return /unique|duplicate/i.test(error.message)
    ? { kind: 'conflict', message: 'Another run of this issue is already in flight.' }
    : storage(error);
}

/**
 * The implement step's thread, kept by a retry when it completed.
 *
 * Not for a "no change" run: its implement step ended without a commit, so
 * replaying that thread reaches "no change" again without running anything
 * (run #229 was retried four times this way). Its retry starts a new agent.
 */
async function keptOnRetry(run: FactoryRunView): Promise<string[]> {
  if (run.state === 'no_change' || run.failureReason === NO_CHANGE_REASON) return [];
  const first = run.threadIds[0];
  if (!first) return [];
  const [row] = await db
    .select({ id: threads.id })
    .from(threads)
    .where(and(eq(threads.id, first), inArray(threads.status, ['completed'])));
  return row ? [first] : [];
}

export function createFactoryRunControl(runs = createFactoryRunsRepository()) {
  /** The run, when it belongs to `factoryId`. */
  const runOf = (factoryId: string, runId: string) =>
    runs
      .get(runId)
      .mapErr(storage)
      .andThen((run) => (run && run.factoryId === factoryId ? okAsync(run) : errAsync(notFound)));

  /** Send a run parked on its issue back to the queue, to be triaged again. */
  const retriaged = (run: FactoryRunView): ResultAsync<undefined, FactoryRunControlError> =>
    runs
      .retriage(run)
      .mapErr(storage)
      .andThen((moved) =>
        moved
          ? okAsync(undefined)
          : errAsync<undefined, FactoryRunControlError>({
              kind: 'conflict',
              message: 'Only a failed run, or one waiting for you, can be retried.',
            }),
      );

  /** The run as it is now (after a change). */
  const reread = (runId: string) =>
    runs
      .get(runId)
      .mapErr(storage)
      .andThen((run) => (run ? okAsync(run) : errAsync(notFound)));

  /** Put a failed or parked run back in flight, as a retry does. */
  const reopened = (run: FactoryRunView): ResultAsync<undefined, FactoryRunControlError> =>
    ResultAsync.fromSafePromise(keptOnRetry(run)).andThen((kept) =>
      runs
        .reopen(run, kept)
        .mapErr(reopenRefused)
        .andThen((outcome) => {
          if (outcome === 'reopened') {
            return ResultAsync.fromSafePromise(
              archiveReplacedFactoryThreads(
                run.threadIds.filter((id) => !kept.includes(id)),
                factoryBrowserEvents(),
              ),
            ).map(() => undefined);
          }
          return errAsync<undefined, FactoryRunControlError>({
            kind: 'conflict',
            message:
              outcome === NO_FREE_SLOT
                ? 'The factory is already running as many runs as it may at once. Retry when one of them finishes.'
                : 'Only a failed run, or one waiting for you, can be retried.',
          });
        }),
    );

  return {
    stop(
      userId: string,
      factoryId: string,
      runId: string,
    ): ResultAsync<FactoryRunView, FactoryRunControlError> {
      return runOf(factoryId, runId).andThen((run) =>
        runs
          .updateInFlight(run.id, { state: 'stopped' })
          .mapErr(storage)
          .andThen((stopped) =>
            stopped
              ? okAsync(run)
              : errAsync<FactoryRunView, FactoryRunControlError>({
                  kind: 'conflict',
                  message: 'The run has already ended.',
                }),
          )
          .andThen((run) => {
            stopFactoryFlow(run.id);
            const ports = factoryRunnerPorts();
            const threadsStopped = ports
              ? stopFactoryThreads(ports, userId, threadsOf(run))
              : Promise.resolve();
            return ResultAsync.fromSafePromise(
              Promise.all([threadsStopped, releaseStoppedIssue(run)]),
            ).andThen(() => reread(run.id));
          }),
      );
    },

    retry(factoryId: string, runId: string): ResultAsync<FactoryRunView, FactoryRunControlError> {
      return runOf(factoryId, runId)
        .andThen((run) =>
          // A run parked on its issue has done no work to keep: it is triaged again.
          run.state === 'needs_info' ? retriaged(run) : reopened(run),
        )
        .andThen(() => {
          wake(factoryId);
          return reread(runId);
        });
    },

    /**
     * Approve merging the run's held high-risk head commit, then retry it.
     * Refused unless the run waits for a person because of that risk. When
     * the factory has no free slot the approval stays recorded, so a later
     * Retry merges the same commit.
     */
    approveMerge(
      userId: string,
      factoryId: string,
      runId: string,
    ): ResultAsync<{ run: FactoryRunView; sha: string }, FactoryRunControlError> {
      return runOf(factoryId, runId).andThen((run) => {
        const sha = run.risk?.level === 'high' ? run.risk.headSha : null;
        if (run.state !== 'waiting_human' || run.failureReason !== HIGH_RISK_HOLD || !sha) {
          return errAsync<{ run: FactoryRunView; sha: string }, FactoryRunControlError>({
            kind: 'conflict',
            message: 'Only a run waiting for your approval of a high-risk change can be approved.',
          });
        }
        return runs
          .approveMerge(run.id, { sha, userId, at: new Date().toISOString() })
          .mapErr(storage)
          .andThen((written) =>
            written
              ? reopened(run)
              : errAsync<undefined, FactoryRunControlError>({
                  kind: 'conflict',
                  message: 'The run is no longer waiting for your approval.',
                }),
          )
          .andThen(() => {
            wake(factoryId);
            return reread(runId);
          })
          .map((current) => ({ run: current, sha }));
      });
    },
  };
}

/**
 * The runner persisted a terminal status for a thread: wake the flow step
 * waiting on it, and when a member's follow-up completed the last agent thread
 * of a failed or parked run, put the run back in flight (take over).
 */
/** Whether the owner followed up on the thread after the run parked (`completedAt`). */
function followedUpAfterParking(run: FactoryRunView, threadId: string): boolean {
  const noted = ownerFollowUpAt(threadId);
  if (noted === undefined || !run.completedAt) return false;
  return noted >= Date.parse(run.completedAt);
}

export async function onFactoryThreadTerminal(threadId: string, status: string): Promise<void> {
  signalThreadTerminal(threadId);
  if (status !== 'completed') return;
  const runs = createFactoryRunsRepository();
  const found = await runs.reopenableByThread(threadId);
  if (found.isErr()) return;
  for (const run of found.value) {
    // Only the implementing thread takes a run over, never a step's own read-only thread.
    if (implementingThreadOf(run) !== threadId || !followedUpAfterParking(run, threadId)) {
      continue;
    }
    const reopened = await runs.reopen(run, run.threadIds);
    if (reopened.isOk() && reopened.value === NO_FREE_SLOT) {
      // The factory is full: the run stays parked, and a later completion of
      // the member's follow-up (or a Retry) may still take it over.
      log.info('Issue factory take-over deferred: the factory has no free slot', {
        namespace: 'factory',
        runId: run.id,
        threadId,
      });
      continue;
    }
    forgetOwnerFollowUp(threadId);
    if (reopened.isOk() && reopened.value === 'reopened') {
      log.info('Issue factory run taken over by a follow-up', {
        namespace: 'factory',
        runId: run.id,
        threadId,
      });
      wake(run.factoryId);
    }
  }
}
