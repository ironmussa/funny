/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: application
 *
 * Merge approval requests (openspec factory-agent-tools): an agent asks the
 * member to approve merging a run the factory holds as high risk. A state
 * machine with compare-and-set writers:
 *
 *   pending ──▶ approved   the run's merge approval covers the request's commit
 *      ├──────▶ declined   the member declined it
 *      └──────▶ expired    the run is held on another commit, or left the hold
 *
 * A request approves nothing. The member approves the run's commit with their
 * own session (`factory.approveMerge`); `nextRequestState` then reads the run
 * and closes the request. No writer here touches a run.
 *
 * At most one pending request exists per run (the partial unique index of
 * migration 127), so asking is an insert the index refuses when one is pending.
 */

import type {
  FactoryApprovalRequest,
  FactoryApprovalRequestState,
} from '@funny/shared/contracts/factory';
import { errorMessage } from '@funny/shared/errors';
import { and, desc, eq, ne } from 'drizzle-orm';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import { db } from '../../db/index.js';
import { factoryApprovalRequests } from '../../db/schema.js';
import { HIGH_RISK_HOLD, type FactoryRunView } from './factory-runs.js';

/** Each transition and the states it may start from. */
const REQUEST_TRANSITIONS = {
  approved: { from: ['pending'] },
  declined: { from: ['pending'] },
  expired: { from: ['pending'] },
} as const satisfies Record<
  Exclude<FactoryApprovalRequestState, 'pending'>,
  { from: readonly FactoryApprovalRequestState[] }
>;

type Resolution = keyof typeof REQUEST_TRANSITIONS;

export type FactoryApprovalRequestsError = { kind: 'storage'; message: string };

/** A request with what only the server reads. */
export interface FactoryApprovalRequestRecord extends FactoryApprovalRequest {
  factoryId: string;
}

type Row = typeof factoryApprovalRequests.$inferSelect;

const storage = (cause: unknown): FactoryApprovalRequestsError => ({
  kind: 'storage',
  message: errorMessage(cause),
});

const STATES: readonly FactoryApprovalRequestState[] = [
  'pending',
  'approved',
  'declined',
  'expired',
];

const toRecord = (row: Row): FactoryApprovalRequestRecord => ({
  id: row.id,
  runId: row.runId,
  factoryId: row.factoryId,
  projectId: row.projectId,
  threadId: row.threadId,
  sha: row.sha,
  // An unknown stored state offers no approval.
  state: STATES.find((state) => state === row.state) ?? 'expired',
  createdAt: row.createdAt,
  resolvedAt: row.resolvedAt ?? null,
});

/** The request as a member or an agent sees it. */
export function publicApprovalRequest(
  record: FactoryApprovalRequestRecord,
): FactoryApprovalRequest {
  const { factoryId: _factory, ...request } = record;
  return request;
}

/** What a run says about its hold: the fields `nextRequestState` reads. */
export type RequestRunFacts = Pick<
  FactoryRunView,
  'state' | 'failureReason' | 'risk' | 'mergeApproval'
>;

/** The commit a run is held on for a member's approval, or null when it is not held. */
export function heldCommit(run: RequestRunFacts): string | null {
  if (run.state !== 'waiting_human' || run.failureReason !== HIGH_RISK_HOLD) return null;
  return run.risk?.level === 'high' ? run.risk.headSha : null;
}

/**
 * Where a pending request goes given its run now, or null to stay pending.
 * `approved` when a member's approval covers the request's commit (it was
 * given for it, or given for it and then moved on); `expired` when the run is
 * no longer held on that commit. A gone run expires its request.
 */
export function nextRequestState(
  request: Pick<FactoryApprovalRequest, 'state' | 'sha'>,
  run: RequestRunFacts | null,
): 'approved' | 'expired' | null {
  if (request.state !== 'pending') return null;
  if (!run) return 'expired';
  const approval = run.mergeApproval;
  if (approval && (approval.sha === request.sha || approval.carriedFrom === request.sha)) {
    return 'approved';
  }
  return heldCommit(run) === request.sha ? null : 'expired';
}

export function createFactoryApprovalRequestsRepository(
  deps: { newId: () => string; now: () => Date } = {
    newId: () => crypto.randomUUID(),
    now: () => new Date(),
  },
) {
  /** Close a request, only from its legal states; whether it moved. */
  const resolve = (
    id: string,
    to: Resolution,
    by: string | null,
  ): ResultAsync<boolean, FactoryApprovalRequestsError> =>
    ResultAsync.fromPromise(
      db
        .update(factoryApprovalRequests)
        .set({ state: to, resolvedAt: deps.now().toISOString(), resolvedBy: by })
        .where(
          and(
            eq(factoryApprovalRequests.id, id),
            // Every transition starts from `pending` (REQUEST_TRANSITIONS).
            eq(factoryApprovalRequests.state, REQUEST_TRANSITIONS[to].from[0]),
          ),
        )
        .returning({ id: factoryApprovalRequests.id }),
      storage,
    ).map((rows) => rows.length > 0);

  const pendingForRun = (
    runId: string,
  ): ResultAsync<FactoryApprovalRequestRecord | null, FactoryApprovalRequestsError> =>
    ResultAsync.fromPromise(
      db
        .select()
        .from(factoryApprovalRequests)
        .where(
          and(
            eq(factoryApprovalRequests.runId, runId),
            eq(factoryApprovalRequests.state, 'pending'),
          ),
        ),
      storage,
    ).map((rows) => (rows[0] ? toRecord(rows[0]) : null));

  return {
    resolve,
    pendingForRun,

    /** One request by its id, or null. */
    get(
      id: string,
    ): ResultAsync<FactoryApprovalRequestRecord | null, FactoryApprovalRequestsError> {
      return ResultAsync.fromPromise(
        db.select().from(factoryApprovalRequests).where(eq(factoryApprovalRequests.id, id)),
        storage,
      ).map((rows) => (rows[0] ? toRecord(rows[0]) : null));
    },

    /**
     * The pending request of `run` for `sha`, created when there is none. A
     * pending request for another commit is expired first. `created` says
     * whether this call made it (asking twice does not).
     */
    ask(input: {
      runId: string;
      factoryId: string;
      projectId: string;
      threadId: string;
      sha: string;
    }): ResultAsync<
      { request: FactoryApprovalRequestRecord; created: boolean },
      FactoryApprovalRequestsError
    > {
      const now = deps.now().toISOString();
      const id = deps.newId();
      return ResultAsync.fromPromise(
        db
          .update(factoryApprovalRequests)
          .set({ state: 'expired', resolvedAt: now, resolvedBy: null })
          .where(
            and(
              eq(factoryApprovalRequests.runId, input.runId),
              eq(factoryApprovalRequests.state, 'pending'),
              ne(factoryApprovalRequests.sha, input.sha),
            ),
          ),
        storage,
      )
        .andThen(() =>
          ResultAsync.fromPromise(
            db
              .insert(factoryApprovalRequests)
              .values({ ...input, id, state: 'pending', createdAt: now })
              // The partial unique index: another request of the run is pending.
              .onConflictDoNothing()
              .returning({ id: factoryApprovalRequests.id }),
            storage,
          ),
        )
        .andThen((inserted) =>
          pendingForRun(input.runId).andThen((request) =>
            request
              ? okAsync({ request, created: inserted.length > 0 })
              : errAsync<
                  { request: FactoryApprovalRequestRecord; created: boolean },
                  FactoryApprovalRequestsError
                >(storage(new Error('The approval request was closed while it was made'))),
          ),
        );
    },

    /** A factory's requests, newest first. */
    listForFactory(
      factoryId: string,
      limit = 50,
    ): ResultAsync<FactoryApprovalRequestRecord[], FactoryApprovalRequestsError> {
      return ResultAsync.fromPromise(
        db
          .select()
          .from(factoryApprovalRequests)
          .where(eq(factoryApprovalRequests.factoryId, factoryId))
          .orderBy(desc(factoryApprovalRequests.createdAt))
          .limit(limit),
        storage,
      ).map((rows) => rows.map(toRecord));
    },

    /**
     * Bring the run's pending request in line with the run: closed as approved
     * or expired when `nextRequestState` says so. Resolves the request that
     * changed (in its new state), or null when nothing did.
     */
    sync(
      runId: string,
      run: RequestRunFacts | null,
      approvedBy: string | null = null,
    ): ResultAsync<FactoryApprovalRequestRecord | null, FactoryApprovalRequestsError> {
      return pendingForRun(runId).andThen((request) => {
        const next = request ? nextRequestState(request, run) : null;
        if (!request || !next) return okAsync(null);
        return resolve(request.id, next, next === 'approved' ? approvedBy : null).map((moved) =>
          moved ? { ...request, state: next, resolvedAt: deps.now().toISOString() } : null,
        );
      });
    },
  };
}
