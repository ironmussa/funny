/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: application
 *
 * The factory runs repository's reads (split out of `factory-runs.ts`).
 */
import { and, desc, eq, gte, inArray, isNotNull, like, notInArray, or, sql } from 'drizzle-orm';
import { ResultAsync } from 'neverthrow';

import { db } from '../../db/index.js';
import { factoryRuns, factorySettings } from '../../db/schema.js';
import {
  storage,
  toView,
  TERMINAL_STATES,
  PARKED_STATES,
  WAITING_STATES,
  UNMERGED_END_STATES,
  RETRYABLE_STATES,
  FAILED_RUN_WINDOW_MS,
  HIGH_RISK_HOLD,
  awaitsPullRequest,
  type FactoryRunsError,
  type FactoryRunView,
} from './factory-runs-model.js';
import { withStepTimings } from './factory-step-timings.js';

/** Runs holding a concurrency slot: non-terminal and not parked for a person. */
export const inFlight = (factoryId: string): ResultAsync<FactoryRunView[], FactoryRunsError> =>
  ResultAsync.fromPromise(
    db
      .select()
      .from(factoryRuns)
      .where(
        and(
          eq(factoryRuns.factoryId, factoryId),
          notInArray(factoryRuns.state, [...TERMINAL_STATES, ...PARKED_STATES, ...WAITING_STATES]),
        ),
      ),
    storage,
  ).map((rows) => rows.map(toView));

/** The repository's reads of runs: lists, lookups and counts. */
export function runReadOperations() {
  return {
    /** Runs for a factory, newest first. */
    list(factoryId: string): ResultAsync<FactoryRunView[], FactoryRunsError> {
      return ResultAsync.fromPromise(
        db
          .select()
          .from(factoryRuns)
          .where(eq(factoryRuns.factoryId, factoryId))
          .orderBy(desc(factoryRuns.startedAt)),
        storage,
      )
        .map((rows) => rows.map(toView))
        .andThen((runs) => withStepTimings(runs, storage));
    },

    /**
     * The runs of every factory `userId` owns that the thread lists show on
     * their threads: not ended (in flight, or parked waiting for the member),
     * or ended without a merge (failed, stopped, no change) within
     * `FAILED_RUN_WINDOW_MS`. A thread shows busy while its run works outside
     * the agent (CI, merge), the error icon once it failed, and that it ended
     * when it was stopped: its agent's own "completed" would read as done.
     * Queued (`requested`) runs have no thread yet; they are returned once
     * admitted, so a thread can say its issue was sent again.
     */
    activeForOwner(
      userId: string,
      now: number = Date.now(),
    ): ResultAsync<FactoryRunView[], FactoryRunsError> {
      const failedSince = new Date(now - FAILED_RUN_WINDOW_MS).toISOString();
      return ResultAsync.fromPromise(
        db
          .select({ run: factoryRuns })
          .from(factoryRuns)
          .innerJoin(factorySettings, eq(factorySettings.id, factoryRuns.factoryId))
          .where(
            and(
              eq(factorySettings.userId, userId),
              or(
                notInArray(factoryRuns.state, [...TERMINAL_STATES, ...WAITING_STATES]),
                and(
                  inArray(factoryRuns.state, [...UNMERGED_END_STATES]),
                  gte(factoryRuns.completedAt, failedSince),
                ),
              ),
            ),
          ),
        storage,
      ).map((rows) => rows.map(({ run }) => toView(run)));
    },

    /**
     * What the factory view lists: every run of `userId`'s factories that has
     * not ended (queued, in flight, or waiting for the member), or ended (merged,
     * failed, stopped) within `FAILED_RUN_WINDOW_MS`, with the project its
     * factory belongs to.
     */
    queueForOwner(
      userId: string,
      now: number = Date.now(),
    ): ResultAsync<Array<FactoryRunView & { projectId: string }>, FactoryRunsError> {
      const endedSince = new Date(now - FAILED_RUN_WINDOW_MS).toISOString();
      return ResultAsync.fromPromise(
        db
          .select({ run: factoryRuns, projectId: factorySettings.projectId })
          .from(factoryRuns)
          .innerJoin(factorySettings, eq(factorySettings.id, factoryRuns.factoryId))
          .where(
            and(
              eq(factorySettings.userId, userId),
              or(
                notInArray(factoryRuns.state, [...TERMINAL_STATES]),
                gte(factoryRuns.completedAt, endedSince),
              ),
            ),
          )
          .orderBy(desc(factoryRuns.startedAt)),
        storage,
      )
        .map((rows) => rows.map(({ run, projectId }) => ({ ...toView(run), projectId })))
        .andThen((runs) => withStepTimings(runs, storage));
    },

    /** The non-terminal run for an issue, if any — the admission dedup check. */
    activeByIssue(
      factoryId: string,
      issueNumber: number,
    ): ResultAsync<FactoryRunView | null, FactoryRunsError> {
      return ResultAsync.fromPromise(
        db
          .select()
          .from(factoryRuns)
          .where(
            and(
              eq(factoryRuns.factoryId, factoryId),
              eq(factoryRuns.issueNumber, issueNumber),
              notInArray(factoryRuns.state, [...TERMINAL_STATES]),
            ),
          ),
        storage,
      ).map((rows) => (rows[0] ? toView(rows[0]) : null));
    },

    /**
     * Whether a run of the issue already settled it: it merged (the issue may
     * keep its label and stay open for a moment after the merge), or it ended
     * with no change (the agent would only say the same). The label does not
     * admit it again; a person sends or retries it.
     */
    settledByEarlierRun(
      factoryId: string,
      issueNumber: number,
    ): ResultAsync<boolean, FactoryRunsError> {
      return ResultAsync.fromPromise(
        db
          .select({ id: factoryRuns.id })
          .from(factoryRuns)
          .where(
            and(
              eq(factoryRuns.factoryId, factoryId),
              eq(factoryRuns.issueNumber, issueNumber),
              inArray(factoryRuns.state, ['merged', 'no_change']),
            ),
          )
          .limit(1),
        storage,
      ).map((rows) => rows.length > 0);
    },

    /** How many times an issue's run has failed — the retry cap. */
    failedCount(factoryId: string, issueNumber: number): ResultAsync<number, FactoryRunsError> {
      return ResultAsync.fromPromise(
        db
          .select({ id: factoryRuns.id })
          .from(factoryRuns)
          .where(
            and(
              eq(factoryRuns.factoryId, factoryId),
              eq(factoryRuns.issueNumber, issueNumber),
              eq(factoryRuns.state, 'failed'),
            ),
          ),
        storage,
      ).map((rows) => rows.length);
    },

    /** The parked runs of a factory that may still close by their pull request (`awaitsPullRequest`). */
    awaitingPullRequest(factoryId: string): ResultAsync<FactoryRunView[], FactoryRunsError> {
      return ResultAsync.fromPromise(
        db
          .select()
          .from(factoryRuns)
          .where(and(eq(factoryRuns.factoryId, factoryId), awaitsPullRequest())),
        storage,
      ).map((rows) => rows.map(toView));
    },

    /**
     * The runs of every factory merged since `since` whose pull request is in
     * `repo` (`owner/name`), newest first, with their enabler: what a broken
     * base branch may be traced to.
     */
    mergedSince(
      repo: string,
      since: string,
    ): ResultAsync<Array<FactoryRunView & { userId: string }>, FactoryRunsError> {
      return ResultAsync.fromPromise(
        db
          .select({ run: factoryRuns, userId: factorySettings.userId })
          .from(factoryRuns)
          .innerJoin(factorySettings, eq(factorySettings.id, factoryRuns.factoryId))
          .where(
            and(
              eq(factoryRuns.state, 'merged'),
              gte(factoryRuns.completedAt, since),
              // The repository is known in lowercase; GitHub's URL keeps its own case.
              like(
                sql`lower(${factoryRuns.prUrl})`,
                `https://github.com/${repo.toLowerCase()}/pull/%`,
              ),
            ),
          )
          .orderBy(desc(factoryRuns.completedAt)),
        storage,
      ).map((rows) => rows.map(({ run, userId }) => ({ ...toView(run), userId })));
    },

    /** The runs parked for a member's approval of a high-risk pull request. */
    awaitingApproval(factoryId: string): ResultAsync<FactoryRunView[], FactoryRunsError> {
      return ResultAsync.fromPromise(
        db
          .select()
          .from(factoryRuns)
          .where(
            and(
              eq(factoryRuns.factoryId, factoryId),
              eq(factoryRuns.state, 'waiting_human'),
              eq(factoryRuns.failureReason, HIGH_RISK_HOLD),
              isNotNull(factoryRuns.prUrl),
            ),
          ),
        storage,
      ).map((rows) => rows.map(toView));
    },

    /** One run by its id, or null. */
    get(runId: string): ResultAsync<FactoryRunView | null, FactoryRunsError> {
      return ResultAsync.fromPromise(
        db.select().from(factoryRuns).where(eq(factoryRuns.id, runId)),
        storage,
      ).map((rows) => (rows[0] ? toView(rows[0]) : null));
    },

    /** The parked or failed runs a thread belongs to (a member following up on it). */
    reopenableByThread(threadId: string): ResultAsync<FactoryRunView[], FactoryRunsError> {
      return ResultAsync.fromPromise(
        db
          .select()
          .from(factoryRuns)
          .where(
            and(
              inArray(factoryRuns.state, [...RETRYABLE_STATES]),
              // Narrowed in SQL (thread_ids is a JSON array); the exact match is below.
              like(factoryRuns.threadIds, `%${JSON.stringify(threadId)}%`),
            ),
          ),
        storage,
      ).map((rows) => rows.map(toView).filter((run) => run.threadIds.includes(threadId)));
    },
  };
}
