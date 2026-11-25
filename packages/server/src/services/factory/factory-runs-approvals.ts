/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: application
 *
 * The factory runs repository's merge approval writes (split out of
 * `factory-runs.ts`): every one a compare-and-set on the stored state or value.
 */
import {
  type FactoryApprovalGap,
  type FactoryApprovalMove,
  type FactoryMergeApproval,
} from '@funny/shared/contracts/factory';
import { and, eq } from 'drizzle-orm';
import { okAsync, ResultAsync } from 'neverthrow';

import { db } from '../../db/index.js';
import { factoryRuns } from '../../db/schema.js';
import {
  storage,
  parseMergeApproval,
  HIGH_RISK_HOLD,
  type FactoryRunsError,
} from './factory-runs-model.js';

/** An approval that moved to a commit with the same change. */
const SAME_CHANGE = { kind: 'same', lines: 0, files: [] } satisfies Pick<
  FactoryApprovalMove,
  'kind' | 'lines' | 'files'
>;
/** A move records at most this many of the files that differ. */
const MAX_MOVE_FILES = 20;

/**
 * Rewrite the run's merge approval while it is still the approval of `sha`:
 * read it, then write `rewrite`'s answer only if the stored value did not
 * change (a compare-and-set). Resolves whether it was written.
 */
const rewriteMergeApproval = (
  runId: string,
  sha: string,
  rewrite: (approval: FactoryMergeApproval) => FactoryMergeApproval,
): ResultAsync<boolean, FactoryRunsError> =>
  ResultAsync.fromPromise(
    db
      .select({ mergeApproval: factoryRuns.mergeApproval })
      .from(factoryRuns)
      .where(eq(factoryRuns.id, runId)),
    storage,
  ).andThen((rows) => {
    const stored = rows[0]?.mergeApproval ?? null;
    const approval = parseMergeApproval(stored);
    if (!stored || approval?.sha !== sha) return okAsync(false);
    return ResultAsync.fromPromise(
      db
        .update(factoryRuns)
        .set({ mergeApproval: JSON.stringify(rewrite(approval)) })
        .where(and(eq(factoryRuns.id, runId), eq(factoryRuns.mergeApproval, stored)))
        .returning({ id: factoryRuns.id }),
      storage,
    ).map((updated) => updated.length > 0);
  });

/** The repository's writes of a run's merge approval. */
export function mergeApprovalOperations() {
  return {
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
     * Move the run's merge approval of `from` to `to`, which holds the same
     * change or one `approvalCovers` found covered. A compare-and-set on the
     * stored value, so a new approval written meanwhile is kept. Resolves
     * whether it moved.
     */
    carryMergeApproval(
      runId: string,
      from: string,
      to: string,
      move: Pick<FactoryApprovalMove, 'kind' | 'lines' | 'files'> = SAME_CHANGE,
    ): ResultAsync<boolean, FactoryRunsError> {
      // The gap was about a commit the approval did not cover: it covers this one.
      return rewriteMergeApproval(runId, from, ({ gap: _covered, ...approval }) => ({
        ...approval,
        sha: to,
        carriedFrom: approval.carriedFrom ?? from,
        moves: [
          ...(approval.moves ?? []),
          {
            to,
            at: new Date().toISOString(),
            kind: move.kind,
            lines: move.lines,
            files: move.files.slice(0, MAX_MOVE_FILES),
          },
        ],
      }));
    },

    /**
     * Record on the run's merge approval of `approved` why it does not cover a
     * later commit and what differs (openspec factory-merge-fewer-bounces,
     * D2). A compare-and-set on the stored value: an approval written or moved
     * meanwhile is kept as it is. Resolves whether it was written.
     */
    noteApprovalGap(
      runId: string,
      approved: string,
      gap: FactoryApprovalGap,
    ): ResultAsync<boolean, FactoryRunsError> {
      return rewriteMergeApproval(runId, approved, (approval) => ({ ...approval, gap }));
    },
  };
}
