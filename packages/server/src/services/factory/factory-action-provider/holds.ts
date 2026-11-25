/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: application
 *
 * Why `merge` holds a run for a person or sends its change back: the review
 * gate, the risk gate, and the merge rounds the implementing agent has left.
 */

import { reviewAllowsMerge, type FactoryReviewVerdict } from '@funny/shared/contracts/factory';
import type { ActionResult, MergeOpts } from '@funny/workflows/compiler';

import type { createMergeLane } from '../factory-merge-lane.js';
import type { createFactoryReviewer } from '../factory-review.js';
import type { ActionCore } from './core.js';
import { MAX_MERGE_ROUNDS_TO_AGENT, MERGE_HOLD_REASONS, type SentBackMetadata } from './shared.js';

/** What the merge holds read of the rest of the provider. */
interface MergeHoldLinks {
  reviewer: Pick<ReturnType<typeof createFactoryReviewer>, 'verdicts'>;
  lane: Pick<ReturnType<typeof createMergeLane>, 'isBaseMergeOf' | 'updateBase'>;
  riskReasons(sha: string): Promise<string[] | null>;
  carryChecks(from: string, to: string): Promise<void>;
}

/** The gates `merge` checks and the ways it ends without merging. */
export function createMergeHolds(core: ActionCore, links: MergeHoldLinks) {
  const { deps, state, count, pullRequest } = core;
  const { reviewer, lane, riskReasons, carryChecks } = links;
  /** Leave the run for a person instead of merging, with why. Not ok, so the flow stops here. */
  async function holdMerge(reason: string, error: string): Promise<ActionResult> {
    await deps.record({ state: 'waiting_human', failureReason: reason });
    // Why runs stop being unattended: the reason is the event, per repository.
    await count(
      { ...state.metrics, mergeHolds: state.metrics.mergeHolds + 1 },
      { event: `merge_held_${reason.replaceAll(' ', '_')}` },
    );
    return { ok: false, error, metadata: { outcome: 'held', reason } };
  }

  /**
   * A branch whose head no longer contains the commit reviewed before it was
   * rewritten (a rebase or a force push): the run waits for a person. An
   * unreadable history holds nothing here; the review gate still applies.
   */
  async function historyRewritten(sha: string): Promise<ActionResult | null> {
    const pr = pullRequest();
    const previous = reviewer
      .verdicts()
      .filter((review) => review.sha !== sha)
      .at(-1);
    if (!pr || !previous) return null;
    // Commits of the reviewed commit that the head lacks: none, unless history was rewritten.
    const distance = await deps.github.pullRequests.baseDistance(pr, previous.sha, sha);
    if (distance.isErr() || distance.value.behindBy === 0) return null;
    return holdMerge(
      MERGE_HOLD_REASONS.rewritten,
      `Not merged: the branch was rewritten. Its head ${sha} no longer contains ${previous.sha}, which was reviewed.`,
    );
  }

  /**
   * The review verdict of `sha`. A head with none that only merges the base
   * branch into the last reviewed commit keeps that commit's review, proof and
   * approval (`carryChecks`): the merge lane carries them when it makes such a
   * merge, but a step that ended before the merge's checks were green (a wait
   * that failed, a restart) leaves the merged head without them.
   */
  async function verdictOf(sha: string): Promise<FactoryReviewVerdict | undefined> {
    const own = reviewer.verdicts().find((review) => review.sha === sha);
    if (own) return own;
    const last = reviewer.verdicts().at(-1);
    if (!last || !(await lane.isBaseMergeOf(last.sha, sha))) return undefined;
    await carryChecks(last.sha, sha);
    return reviewer.verdicts().find((review) => review.sha === sha);
  }

  /**
   * What `merge` checks itself on entry, whatever path led to it (a repository
   * flow draws its own): the head commit has a verdict of the flow's own
   * `review` step that allows a merge (unless `require_review: false`), and
   * its risk class is one the factory merges by itself. A check, status or
   * approval an external reviewer left on the pull request is not a verdict.
   * Null when the merge may go on.
   */
  async function mergeHeld(opts: MergeOpts, sha: string): Promise<ActionResult | null> {
    return (await reviewHeld(opts, sha)) ?? (await riskHeld(sha));
  }

  /** The review gate of `mergeHeld`: the commit's history and its verdict. */
  async function reviewHeld(opts: MergeOpts, sha: string): Promise<ActionResult | null> {
    // A regenerated change (D9) is produced again on each new base: its
    // history may be rewritten, and its review gate still applies.
    const rewritten = opts.regenerate ? null : await historyRewritten(sha);
    if (rewritten) return rewritten;
    if (opts.requireReview !== false) {
      const verdict = await verdictOf(sha);
      if (!verdict) {
        return holdMerge(
          MERGE_HOLD_REASONS.noReview,
          `Not merged: commit ${sha} has no review. A flow's merge needs a passing review step for the commit it merges, or \`require_review: false\`.`,
        );
      }
      if (!reviewAllowsMerge(verdict)) {
        return holdMerge(
          MERGE_HOLD_REASONS.reviewFailed,
          `Not merged: the review of commit ${sha} did not pass.`,
        );
      }
    }
    return null;
  }

  /** The risk gate of `mergeHeld`: a high-risk change waits for a member's approval. */
  async function riskHeld(sha: string): Promise<ActionResult | null> {
    const reasons = await riskReasons(sha);
    if (!reasons) return null;
    return holdMerge(
      MERGE_HOLD_REASONS.highRisk,
      `Not merged: the change is high risk (${reasons.join('; ')}). This factory merges only low-risk changes by itself.`,
    );
  }

  /**
   * The head a high-risk change is held on (openspec
   * factory-approval-survives-integration, D1): the base is brought in first,
   * without waiting for the new head's checks, so the commit a member approves
   * already has it. Approving a head that is behind made a new commit, which
   * waited for a person again. Resolves with the hold, or with what the update
   * ended in when it could not be made; null when `sha` is not held for its risk.
   */
  async function heldOnCurrentBase(sha: string, baseRef: string): Promise<ActionResult | null> {
    if (!(await riskReasons(sha))) return null;
    const pr = pullRequest();
    // GitHub's merge queue tests the change on the current base itself.
    const queue = pr ? await deps.github.pullRequests.mergeQueueRequired(pr, baseRef) : null;
    if (!queue || queue.isErr() || queue.value) return riskHeld(sha);
    const current = await lane.updateBase();
    if (current.kind === 'failed') return { ok: false, error: current.error };
    if (current.kind === 'sent-back') return sentBack(current.why, current.feedback);
    for (const step of current.carried) await carryChecks(step.from, step.to);
    return riskHeld(current.sha);
  }

  /**
   * A merge round is about to reach the implementing agent: count it, or park
   * the run when it already had its rounds (three agent fixes of one merge
   * rarely converge, and every round costs a full CI and review).
   */
  async function mergeRoundToImplementer(): Promise<ActionResult | null> {
    if (state.metrics.mergeRoundsToAgent >= MAX_MERGE_ROUNDS_TO_AGENT) {
      return holdMerge(
        MERGE_HOLD_REASONS.mergeRounds,
        `Not merged: ${MAX_MERGE_ROUNDS_TO_AGENT} rounds of fixes by the agent did not get the change to merge with its base. A person has to look at it.`,
      );
    }
    await count(
      { ...state.metrics, mergeRoundsToAgent: state.metrics.mergeRoundsToAgent + 1 },
      { event: 'merge_round_to_agent' },
    );
    return null;
  }

  /** `merge` sent the change back to the implementing agent: ok, so the flow's loop can act. */
  async function sentBack(why: 'conflict' | 'checks', feedback: string): Promise<ActionResult> {
    // A regenerable change (D9) goes back to the node that produces it: no agent round.
    const regenerate = why === 'conflict' ? state.regenerating : undefined;
    // A conflict goes to the flow's integrate step first, which may settle it alone.
    if (!regenerate && (why === 'checks' || !deps.flowIntegrates)) {
      const parked = await mergeRoundToImplementer();
      if (parked) return parked;
    }
    await count(
      { ...state.metrics, mergeSentBack: state.metrics.mergeSentBack + 1 },
      { event: `merge_sent_back_${why}` },
    );
    const metadata: SentBackMetadata = { outcome: 'sent_back', why, feedback };
    if (regenerate) metadata.regenerate = regenerate;
    return { ok: true, output: 'sent_back', metadata };
  }

  /** `mergeHeld` on entry to `merge`, with the risk hold on a head that includes the base. */
  async function heldOnEntry(
    opts: MergeOpts,
    sha: string,
    baseRef: string,
  ): Promise<ActionResult | null> {
    return (await reviewHeld(opts, sha)) ?? (await heldOnCurrentBase(sha, baseRef));
  }

  return { holdMerge, mergeHeld, heldOnEntry, mergeRoundToImplementer, sentBack };
}
