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
 *   checked in the same step as the write); otherwise it waits at the head of
 *   the queue for the next one. A completed implement step is kept (its thread
 *   replays); every later step runs again, so a CI fix loop gets its fixes
 *   back. A "no change" run keeps nothing: a new agent implements the issue.
 *   The threads a retry does not keep are archived, so the list does not
 *   show the old failed thread next to the new one with the same title.
 * - **Split** a run parked because its issue is too large: the parts triage
 *   proposed are opened as issues and queued, and the run ends `done`.
 * - **Approve the merge** of a run held because its change is high risk: the
 *   member's approval of that head commit is recorded, and the run is retried.
 *   The merge gate lets only the approved commit through, or a merge of it
 *   with the base that settled nothing (the approval is carried with the
 *   review and the proof); any other push needs a new approval. Every other
 *   gate (review, proof, CI) still applies.
 * - **Take over** a run: a member follows up on the run's last agent thread;
 *   when that thread completes again, a failed or parked run goes back in
 *   flight with all its steps replayed, so the flow continues from that step
 *   with the member's input (`onFactoryThreadTerminal`).
 *
 * The caller (the tRPC port) has checked `steer` and that the factory is
 * theirs; here a run must belong to that factory.
 */

import {
  contractOf,
  FACTORY_ON_HOLD_LABEL,
  implementingThreadOf,
  isBehaviorNeutralLintCleanup,
  type FactoryRiskWaiver,
} from '@funny/shared/contracts/factory';
import { errorMessage } from '@funny/shared/errors';
import { and, eq, inArray } from 'drizzle-orm';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import { db } from '../../db/index.js';
import { threads } from '../../db/schema.js';
import { log } from '../../lib/logger.js';
import { NO_CHANGE_REASON, NOT_PUSHED_REASON } from './factory-action-provider.js';
import { forgetOwnerFollowUp, ownerFollowUpAt } from './factory-follow-ups.js';
import type { FactoryCloseOutcome, FactoryPullRequestRef } from './factory-pull-requests.js';
import { replacedPullRequest, type ReplacedPullRequest } from './factory-replaced-pr.js';
import { factoryRunBranch, RETRYABLE_STATES } from './factory-runs-model.js';
import {
  createFactoryRunsRepository,
  HIGH_RISK_HOLD,
  threadsOf,
  type FactoryRunView,
} from './factory-runs.js';
import { getWatchedFactory } from './factory-settings.js';
import { createSpecControls, releaseSpecOf } from './factory-spec-control.js';
import { onFactorySpecTurn } from './factory-spec.js';
import {
  archiveReplacedFactoryThreads,
  freeRunBranchForRetry,
  stopFactoryThreads,
  type KeptWorktree,
} from './factory-thread-requests.js';
import { signalThreadTerminal } from './factory-thread-waits.js';
import {
  checkFactoryTarget,
  factoryBrowserEvents,
  factoryGithubPort,
  factoryRunnerPorts,
  pokeFactory,
  splitParkedFactoryRun,
  stopFactoryFlow,
} from './factory-watcher.js';

export type FactoryRunControlError = {
  /** `github`: GitHub refused or could not be reached; nothing of the run changed. */
  kind: 'not-found' | 'conflict' | 'storage' | 'github';
  message: string;
};

/** The refusal of an approval that names another commit than the held one. */
const HELD_COMMIT_CHANGED =
  'The change was updated after you opened it. Reload and review the new commit.';

const notFound: FactoryRunControlError = { kind: 'not-found', message: 'Run not found' };
const storage = (error: { message: string }): FactoryRunControlError => ({
  kind: 'storage',
  message: error.message,
});

/** Runs parked before any work (on their issue or their spec): a retry triages them again. */
const PARKED_BEFORE_WORK: ReadonlySet<string> = new Set(['needs_info', 'needs_spec']);

/** Look at the factory now; the request does not wait for the tick. */
function wake(factoryId: string): void {
  void pokeFactory(factoryId).catch((cause: unknown) =>
    log.error('Issue factory poke failed', {
      namespace: 'factory',
      factoryId,
      error: errorMessage(cause),
    }),
  );
}

/**
 * A stopped run (or one taken out of the queue) that the factory took by its
 * label: take the label off the issue, so automatic mode does not queue it
 * again at the next poll. A person
 * who wants it run again puts the label back (or retries the run). Best
 * effort: the stop has happened either way, and a failure is logged.
 */
export async function releaseStoppedIssue(run: FactoryRunView): Promise<void> {
  if (run.source !== 'label') return;
  await relabelRunIssue(run, (label) => (label ? { remove: label } : null), 'stopped');
}

/**
 * Swap labels on a run's issue as its factory's enabler: `labels` gets the
 * factory's trigger label (empty when it has none) and answers what to
 * remove and add, or null for nothing. Best effort: the run's change has
 * happened either way, and a failure is logged.
 */
async function relabelRunIssue(
  run: FactoryRunView,
  labels: (factoryLabel: string) => { remove?: string; add?: string } | null,
  why: 'stopped' | 'put on hold' | 'released',
): Promise<void> {
  if (run.issueNumber === null) return;
  const factory = await getWatchedFactory(run.factoryId);
  const port = factoryGithubPort();
  const swap = factory ? labels(factory.label ?? '') : null;
  if (!factory || !port || !swap) return;
  const target = await checkFactoryTarget(factory);
  if (!target || 'reason' in target) return;
  const reader = { repo: target.repo, ownerId: factory.userId, projectId: factory.projectId };
  const relabelled = await port.relabelIssue(reader, run.issueNumber, swap);
  if (relabelled.isErr()) {
    log.warn(`Issue factory could not relabel the issue of a run ${why}`, {
      namespace: 'factory',
      runId: run.id,
      issue: run.issueNumber,
      error: relabelled.error.message,
    });
  }
}

/**
 * A run put on hold: its issue gets the on-hold label and loses the
 * factory's trigger label, so neither this factory (which also skips issues
 * carrying the on-hold label) nor a person reading GitHub takes it as ready.
 */
const markIssueOnHold = (run: FactoryRunView) =>
  relabelRunIssue(
    run,
    (label) => ({ ...(label && { remove: label }), add: FACTORY_ON_HOLD_LABEL }),
    'put on hold',
  );

/**
 * A run released from hold: the on-hold label comes off its issue, and a run
 * the factory took by its label gets the label back (the watcher drops a
 * labelled run from its queue when its issue no longer carries the label).
 */
const unmarkIssueOnHold = (run: FactoryRunView) =>
  relabelRunIssue(
    run,
    (label) => ({
      remove: FACTORY_ON_HOLD_LABEL,
      ...(run.source === 'label' && label && { add: label }),
    }),
    'released',
  );

/**
 * A run's pull request as its factory's enabler reaches it, or null when the
 * factory, its repository or the GitHub side cannot be resolved now.
 */
async function replacedPullRequestRef(
  run: FactoryRunView,
  replaced: ReplacedPullRequest,
): Promise<FactoryPullRequestRef | null> {
  const factory = await getWatchedFactory(run.factoryId);
  if (!factory || !factoryGithubPort()) return null;
  const target = await checkFactoryTarget(factory);
  if (!target || 'reason' in target) return null;
  return {
    repo: target.repo,
    number: replaced.number,
    branch: replaced.branch,
    userId: factory.userId,
    projectId: factory.projectId,
  };
}

/** A reopen the unique index refused: another run of the issue is in flight. */
function reopenRefused(error: { message: string }): FactoryRunControlError {
  return /unique|duplicate/i.test(error.message)
    ? { kind: 'conflict', message: 'Another run of this issue is already in flight.' }
    : storage(error);
}

/**
 * What is stored when a member says a run triage classed as a lint cleanup is
 * not one (`on: false`), or takes that back (`on: true`). A member never marks
 * a run as one: where triage did not class it, there is nothing to store.
 */
function lintCleanupWord(
  run: FactoryRunView,
  userId: string,
  on: boolean,
): FactoryRiskWaiver | null {
  if (on || !isBehaviorNeutralLintCleanup(contractOf(run))) return null;
  return { kind: 'not-lint-cleanup', userId, at: new Date().toISOString() };
}

/**
 * The implement step's thread, kept by a retry when it completed.
 *
 * Not for a "no change" run: its implement step ended without a commit, so
 * replaying that thread reaches "no change" again without running anything
 * (run #229 was retried four times this way). Its retry starts a new agent.
 * Nor for a "not pushed" one: the step ended before the push, the same way.
 */
async function keptOnRetry(run: FactoryRunView): Promise<string[]> {
  // A run on hold keeps what the state it was held from would.
  const state = run.state === 'on_hold' ? run.hold?.from : run.state;
  if (state === 'no_change' || state === 'needs_info') return [];
  if (run.failureReason === NO_CHANGE_REASON || run.failureReason === NOT_PUSHED_REASON) return [];
  const first = run.threadIds[0];
  if (!first) return [];
  const [row] = await db
    .select({
      id: threads.id,
      worktreePath: threads.worktreePath,
      branch: threads.branch,
      mode: threads.mode,
      runtime: threads.runtime,
    })
    .from(threads)
    .where(and(eq(threads.id, first), inArray(threads.status, ['completed'])));
  if (!row) return [];
  return keepsItsCheckout(row, factoryRunBranch(run)) ? [first] : [];
}

/**
 * Whether a retry can go on in the implement thread's checkout.
 *
 * Not a thread put on another branch (the run's was held by an older
 * worktree): it is refused on every step. Not a worktree thread whose worktree
 * is gone (an earlier retry removed it) either: the runner would run the
 * run's `integrate` and commands in the project's own checkout, on whatever
 * branch the member has there (run #479 failed its `integrate` this way). The
 * retry starts a new agent on the run's branch for both. A sandbox thread and a
 * local-mode one have no worktree path to begin with.
 */
export function keepsItsCheckout(
  thread: {
    worktreePath: string | null;
    branch: string | null;
    mode: string | null;
    runtime: string | null;
  },
  runBranch: string,
): boolean {
  if (thread.worktreePath) return thread.branch === runBranch;
  return thread.mode !== 'worktree' || thread.runtime === 'sandbox';
}

/** Why a retry cannot start: worktrees it could not free hold the run's branch. */
function keptWorktreesConflict(kept: KeptWorktree[]): FactoryRunControlError {
  const where = kept
    .map((k) =>
      k.dirtyFileCount > 0 || k.unpushedCommitCount > 0
        ? `${k.worktreePath} (${k.dirtyFileCount} uncommitted file(s), ${k.unpushedCommitCount} unpushed commit(s))`
        : `${k.worktreePath} (its runner did not answer)`,
    )
    .join(', ');
  return {
    kind: 'conflict',
    message: `Not retried: the run's earlier worktree could not be removed without losing work: ${where}. Save or remove it, then retry.`,
  };
}

/**
 * Remove the worktrees that would keep the retried run off its branch (see
 * `freeRunBranchForRetry`). With no runner ports (tests, a server without
 * runners) there is nothing to ask.
 */
const freedForRetry = (
  run: FactoryRunView,
  kept: string[],
): ResultAsync<undefined, FactoryRunControlError> => {
  const ports = factoryRunnerPorts();
  // A run in flight goes on with its worktree: only a stopped attempt's are removed.
  const retryable: ReadonlySet<string> = new Set([...RETRYABLE_STATES, 'on_hold']);
  if (!ports || !retryable.has(run.state)) return okAsync(undefined);
  return ResultAsync.fromSafePromise(
    freeRunBranchForRetry(
      ports,
      { runBranch: factoryRunBranch(run), threadIds: run.threadIds },
      kept,
      factoryBrowserEvents(),
    ),
  ).andThen((left) =>
    left.length === 0 ? okAsync(undefined) : errAsync(keptWorktreesConflict(left)),
  );
};

type FactoryRuns = ReturnType<typeof createFactoryRunsRepository>;

/** Put `run` on hold (a compare-and-set), then swap its issue's labels. */
function putRunOnHold(
  runs: FactoryRuns,
  run: FactoryRunView,
  userId: string,
  reason: string,
): ResultAsync<undefined, FactoryRunControlError> {
  return runs
    .putOnHold(run.id, { reason, userId, at: new Date().toISOString(), from: run.state })
    .mapErr(reopenRefused)
    .andThen((held) =>
      held
        ? ResultAsync.fromSafePromise(Promise.all([markIssueOnHold(run), releaseSpecOf(run)])).map(
            () => undefined,
          )
        : errAsync<undefined, FactoryRunControlError>({
            kind: 'conflict',
            message:
              'Only a run waiting for a person, or one that ended without merging, can be put on hold. Stop a running one first.',
          }),
    );
}

/**
 * Send a run on hold back to the queue (a compare-and-set), keeping what a
 * retry of the state it was held from keeps; then its issue's labels are
 * swapped back and the threads it does not keep are archived.
 */
function releaseHeldRun(
  runs: FactoryRuns,
  run: FactoryRunView,
): ResultAsync<undefined, FactoryRunControlError> {
  const notHeld = errAsync<never, FactoryRunControlError>({
    kind: 'conflict',
    message: 'Only a run on hold can be released.',
  });
  if (run.state !== 'on_hold') return notHeld;
  return ResultAsync.fromSafePromise(keptOnRetry(run)).andThen((kept) =>
    freedForRetry(run, kept)
      .andThen(() => runs.release(run, kept).mapErr(storage))
      .andThen((moved) => (moved ? okAsync(undefined) : notHeld))
      .andThen(() =>
        ResultAsync.fromSafePromise(
          Promise.all([
            unmarkIssueOnHold(run),
            archiveReplacedFactoryThreads(
              run.threadIds.filter((id) => !kept.includes(id)),
              factoryBrowserEvents(),
            ),
          ]),
        ).map(() => undefined),
      ),
  );
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
          ? // A run that waited on its spec gives its writer's checkout back.
            ResultAsync.fromSafePromise(releaseSpecOf(run)).map(() => undefined)
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
      freedForRetry(run, kept)
        .andThen(() => runs.reopen(run, kept).mapErr(reopenRefused))
        .andThen((outcome) => {
          // Queued: every slot is taken, and the run is first in line for the next one.
          if (outcome === 'reopened' || outcome === 'queued') {
            return ResultAsync.fromSafePromise(
              archiveReplacedFactoryThreads(
                run.threadIds.filter((id) => !kept.includes(id)),
                factoryBrowserEvents(),
              ),
            ).map(() => undefined);
          }
          return errAsync<undefined, FactoryRunControlError>({
            kind: 'conflict',
            message: 'Only a failed run, or one waiting for you, can be retried.',
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
              Promise.all([threadsStopped, releaseStoppedIssue(run), releaseSpecOf(run)]),
            ).andThen(() => reread(run.id));
          }),
      );
    },

    retry(factoryId: string, runId: string): ResultAsync<FactoryRunView, FactoryRunControlError> {
      return runOf(factoryId, runId)
        .andThen((run) =>
          // A run parked on its issue (or its spec) has done no work to keep: it is triaged again.
          PARKED_BEFORE_WORK.has(run.state) ? retriaged(run) : reopened(run),
        )
        .andThen(() => {
          wake(factoryId);
          return reread(runId);
        });
    },

    /**
     * A member says the run needs nothing more: one that ended as `no_change`
     * (they agree with the agent) or `stopped` (e.g. its issue was closed as a
     * duplicate) and stayed on the board for a person becomes `done`. Nothing
     * else is touched: the issue stays as it is on GitHub.
     */
    markDone(
      factoryId: string,
      runId: string,
    ): ResultAsync<FactoryRunView, FactoryRunControlError> {
      return runOf(factoryId, runId).andThen((run) =>
        runs
          .markDone(run.id)
          .mapErr(storage)
          .andThen((written) =>
            written
              ? reread(runId)
              : errAsync<FactoryRunView, FactoryRunControlError>({
                  kind: 'conflict',
                  message:
                    'Only a run that ended with no change or was stopped can be marked as done.',
                }),
          ),
      );
    },

    /**
     * Put a run on hold, as `userId`, with the member's `reason`: one that
     * waits for a person or ended without merging (`HOLDABLE_STATES`) and
     * cannot go on until something outside it changes. It holds its issue but
     * no slot, and the issue gets the on-hold label instead of the trigger
     * label. A run in flight is stopped first.
     */
    hold(
      userId: string,
      factoryId: string,
      runId: string,
      reason: string,
    ): ResultAsync<FactoryRunView, FactoryRunControlError> {
      return runOf(factoryId, runId)
        .andThen((run) => putRunOnHold(runs, run, userId, reason))
        .andThen(() => reread(runId));
    },

    ...createSpecControls({ runs, runOf, reread, wake }),

    /**
     * Release a run on hold: it goes back to the end of the queue and is
     * triaged again, keeping what a retry of the state it was held from keeps.
     * The on-hold label comes off its issue.
     */
    release(factoryId: string, runId: string): ResultAsync<FactoryRunView, FactoryRunControlError> {
      return runOf(factoryId, runId)
        .andThen((run) => releaseHeldRun(runs, run))
        .andThen(() => {
          wake(factoryId);
          return reread(runId);
        });
    },

    /**
     * Close the pull request of a run that a newer run of its issue replaced,
     * and delete its branch, as the factory's enabler. Refused for a run that
     * was not replaced, has not ended, or has no pull request of its own. The
     * run itself does not change.
     */
    closeReplacedPr(
      factoryId: string,
      runId: string,
    ): ResultAsync<{ run: FactoryRunView; outcome: FactoryCloseOutcome }, FactoryRunControlError> {
      const refuse = (message: string) =>
        errAsync<never, FactoryRunControlError>({ kind: 'conflict', message });
      return runOf(factoryId, runId).andThen((run) =>
        runs
          .list(factoryId)
          .mapErr(storage)
          .andThen((all) => {
            const replaced = replacedPullRequest(run, all);
            if (replaced.isErr()) return refuse(replaced.error);
            return ResultAsync.fromSafePromise(replacedPullRequestRef(run, replaced.value)).andThen(
              (ref) => {
                const close = factoryGithubPort()?.pullRequests.closeReplaced;
                if (!ref || !close) {
                  return refuse("The factory cannot reach the run's repository on GitHub now.");
                }
                return close(ref, replaced.value.by)
                  .mapErr((error): FactoryRunControlError => ({
                    kind: 'github',
                    message: error.message,
                  }))
                  .map((outcome) => ({ run, outcome }));
              },
            );
          }),
      );
    },

    /**
     * Say, as `userId`, that a run triage classed as a lint cleanup is not one
     * (`on: false`), or take that back (`on: true`): then its size and its
     * contract's risk hints do not make it high risk again, when the
     * factory's own checks of the diff pass. A run held for its risk is put
     * back in flight so the change is applied to it at once.
     */
    setLintCleanup(
      userId: string,
      factoryId: string,
      runId: string,
      on: boolean,
    ): ResultAsync<FactoryRunView, FactoryRunControlError> {
      return runOf(factoryId, runId).andThen((run) =>
        runs
          .setRiskWaiver(run.id, lintCleanupWord(run, userId, on))
          .mapErr(storage)
          .andThen((written) =>
            written
              ? okAsync<undefined, FactoryRunControlError>(undefined)
              : errAsync<undefined, FactoryRunControlError>({
                  kind: 'conflict',
                  message: 'The run has ended: there is nothing left to class.',
                }),
          )
          .andThen(() => {
            const held = run.state === 'waiting_human' && run.failureReason === HIGH_RISK_HOLD;
            return on && held
              ? reopened(run)
              : okAsync<undefined, FactoryRunControlError>(undefined);
          })
          .andThen(() => {
            wake(factoryId);
            return reread(runId);
          }),
      );
    },

    /**
     * Split a run parked because triage found its issue too large: its
     * proposed parts are opened as issues and queued in this factory, and the
     * run ends `done` (no agent runs). Refused unless it is parked that way.
     */
    split(factoryId: string, runId: string): ResultAsync<FactoryRunView, FactoryRunControlError> {
      return runOf(factoryId, runId)
        .andThen((run) =>
          run.state === 'needs_info' && run.triage?.decision === 'too_big'
            ? ResultAsync.fromSafePromise(splitParkedFactoryRun(run))
            : errAsync<never, FactoryRunControlError>({
                kind: 'conflict',
                message: 'Only a run parked because its issue is too large can be split.',
              }),
        )
        .andThen((opened) =>
          opened.isOk()
            ? okAsync(undefined)
            : errAsync<undefined, FactoryRunControlError>({
                kind: 'conflict',
                message: opened.error,
              }),
        )
        .andThen(() => {
          wake(factoryId);
          return reread(runId);
        });
    },

    /**
     * Approve merging the run's held high-risk head commit, then retry it.
     * Refused unless the run waits for a person because of that risk, and
     * unless `expectedSha` (the commit the member was shown) is the held one. When
     * the factory has no free slot the run waits at the head of the queue.
     */
    approveMerge(
      userId: string,
      factoryId: string,
      runId: string,
      expectedSha: string,
    ): ResultAsync<{ run: FactoryRunView; sha: string }, FactoryRunControlError> {
      return runOf(factoryId, runId).andThen((run) => {
        const sha = run.risk?.level === 'high' ? run.risk.headSha : null;
        if (run.state !== 'waiting_human' || run.failureReason !== HIGH_RISK_HOLD || !sha) {
          return errAsync<{ run: FactoryRunView; sha: string }, FactoryRunControlError>({
            kind: 'conflict',
            message: 'Only a run waiting for your approval of a high-risk change can be approved.',
          });
        }
        // The member approves the commit they saw, never the one that replaced it.
        if (sha !== expectedSha) {
          return errAsync<{ run: FactoryRunView; sha: string }, FactoryRunControlError>({
            kind: 'conflict',
            message: HELD_COMMIT_CHANGED,
          });
        }
        return runs
          .approveMerge(run.id, {
            sha,
            userId,
            at: new Date().toISOString(),
            // What the member accepted: an adjustment may add no risk key to these.
            riskKeys: run.risk?.keys,
          })
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
  // A spec writer's turn (openspec factory-spec-stage): its result is read and
  // stored on the run. A role thread never takes a run over.
  const waitingOnSpec = await runs.waitingOnSpec();
  if (waitingOnSpec.isOk()) {
    for (const run of waitingOnSpec.value) {
      if (run.spec?.threadId === threadId) await onFactorySpecTurn(run, threadId);
    }
  }
  const found = await runs.reopenableByThread(threadId);
  if (found.isErr()) return;
  for (const run of found.value) {
    // Only the implementing thread takes a run over, never a step's own read-only thread.
    if (implementingThreadOf(run) !== threadId || !followedUpAfterParking(run, threadId)) {
      continue;
    }
    const reopened = await runs.reopen(run, run.threadIds);
    forgetOwnerFollowUp(threadId);
    // Queued: the factory is full, and the run takes the next free slot.
    if (reopened.isOk() && (reopened.value === 'reopened' || reopened.value === 'queued')) {
      log.info('Issue factory run taken over by a follow-up', {
        namespace: 'factory',
        runId: run.id,
        threadId,
        queued: reopened.value === 'queued',
      });
      wake(run.factoryId);
    }
  }
}
