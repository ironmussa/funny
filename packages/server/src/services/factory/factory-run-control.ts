/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 *
 * A member's controls over their factory's runs (issue-factory phase 4):
 *
 * - **Stop** a run: it becomes `stopped`, its flow stops in this process and
 *   its running agent threads are stopped on the enabler's runner.
 * - **Retry** a failed or parked run: it goes back in flight on the same
 *   branch and pull request. A completed implement step is kept (its thread
 *   replays); every later step runs again, so a CI fix loop gets its fixes
 *   back. A "no change" run keeps nothing: a new agent implements the issue.
 *   The threads a retry does not keep are archived, so the list does not
 *   show the old failed thread next to the new one with the same title.
 * - **Take over** a run: a member follows up on the run's last agent thread;
 *   when that thread completes again, a failed or parked run goes back in
 *   flight with all its steps replayed, so the flow continues from that step
 *   with the member's input (`onFactoryThreadTerminal`).
 *
 * The caller (the tRPC port) has checked `steer` and that the factory is
 * theirs; here a run must belong to that factory.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import { db } from '../../db/index.js';
import { threads } from '../../db/schema.js';
import { log } from '../../lib/logger.js';
import { NO_CHANGE_REASON } from './factory-action-provider.js';
import { forgetOwnerFollowUp, ownerFollowUpAt } from './factory-follow-ups.js';
import { createFactoryRunsRepository, type FactoryRunView } from './factory-runs.js';
import { archiveReplacedFactoryThreads, stopFactoryThreads } from './factory-thread-requests.js';
import { signalThreadTerminal } from './factory-thread-waits.js';
import {
  factoryBrowserEvents,
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

  /** The run as it is now (after a change). */
  const reread = (runId: string) =>
    runs
      .get(runId)
      .mapErr(storage)
      .andThen((run) => (run ? okAsync(run) : errAsync(notFound)));

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
              ? stopFactoryThreads(ports, userId, run.threadIds)
              : Promise.resolve();
            return ResultAsync.fromSafePromise(threadsStopped).andThen(() => reread(run.id));
          }),
      );
    },

    retry(factoryId: string, runId: string): ResultAsync<FactoryRunView, FactoryRunControlError> {
      return runOf(factoryId, runId)
        .andThen((run) =>
          ResultAsync.fromSafePromise(keptOnRetry(run)).andThen((kept) =>
            runs
              .reopen(run.id, kept)
              .mapErr(reopenRefused)
              .andThen((reopened) =>
                reopened
                  ? ResultAsync.fromSafePromise(
                      archiveReplacedFactoryThreads(
                        run.threadIds.filter((id) => !kept.includes(id)),
                        factoryBrowserEvents(),
                      ),
                    )
                  : errAsync<undefined, FactoryRunControlError>({
                      kind: 'conflict',
                      message: 'Only a failed run, or one waiting for you, can be retried.',
                    }),
              ),
          ),
        )
        .andThen(() => {
          wake(factoryId);
          return reread(runId);
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
    if (run.threadIds.at(-1) !== threadId || !followedUpAfterParking(run, threadId)) continue;
    forgetOwnerFollowUp(threadId);
    const reopened = await runs.reopen(run.id, run.threadIds);
    if (reopened.isOk() && reopened.value) {
      log.info('Issue factory run taken over by a follow-up', {
        namespace: 'factory',
        runId: run.id,
        threadId,
      });
      wake(run.factoryId);
    }
  }
}
