/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: application
 *
 * The merge gate of the factory's `ActionProvider` (`factory-action-provider.ts`):
 * what `merge` checks on entry (history, review, risk), how it brings the
 * branch up to date, leads a batch of the merge queue or goes through
 * GitHub's, and when it holds the run for a person or sends the change back.
 */

import { reviewAllowsMerge, type FactoryReviewVerdict } from '@funny/shared/contracts/factory';
import type { ActionResult, MergeOpts } from '@funny/workflows/compiler';

import type { ClassifiedHead, ProviderContext } from './factory-action-provider-deps.js';
import type { createProofGate } from './factory-action-provider-proof.js';
import type { createFactoryCiActions } from './factory-ci-actions.js';
import { mergeAsBatch } from './factory-merge-batch.js';
import type { createMergeLane } from './factory-merge-lane.js';
import { withBatchStats } from './factory-queue-port.js';
import type { createFactoryReviewer } from './factory-review.js';
import { HIGH_RISK_HOLD } from './factory-runs.js';
import type { createStacking } from './factory-stacking.js';

/**
 * Why `merge` left a run for a person instead of merging (change
 * factory-agent-roles, D8). The run row shows the reason.
 */
export const MERGE_HOLD_REASONS = {
  /** The branch no longer contains the commit that was reviewed before (a force push). */
  rewritten: 'branch history rewritten',
  /** The head commit has no verdict of the flow's `review` step. */
  noReview: 'no review',
  /** Its verdict does not allow a merge. */
  reviewFailed: 'review failed',
  /** The change is high risk and the factory merges only low-risk changes; a member may approve it. */
  highRisk: HIGH_RISK_HOLD,
  /** Its merge rounds that reached the implementing agent are spent. */
  mergeRounds: 'merge rounds spent',
  /** A stacked run whose blocker has not landed, or whose pull request could not be retargeted. */
  stacked: 'stacked',
  /** The merge queue found it may not merge the commit its batch tested, or could not test it. */
  queue: 'merge queue',
} as const;

/** Merge rounds that may reach the implementing agent before the run waits for a person. */
export const MAX_MERGE_ROUNDS_TO_AGENT = 2;

const PROOF_NOT_CONFIGURED: ActionResult = {
  ok: false,
  error:
    'Regression proof not configured: the flow has no regression_proof rules, so the factory does not merge.',
};

type MergeLane = ReturnType<typeof createMergeLane>;

/** What the merge checks are given besides the provider's context. */
interface MergeChecksDeps {
  reviewer: Pick<ReturnType<typeof createFactoryReviewer>, 'verdicts'>;
  classifyHead(): Promise<ClassifiedHead | null>;
  lane: Pick<MergeLane, 'isBaseMergeOf'>;
  /** Carry what was judged of `from` to `to`, a base merge of it that settled nothing. */
  carryChecks(from: string, to: string): Promise<void>;
}

/** When `merge` holds the run for a person, or sends the change back. */
export function createMergeChecks(ctx: ProviderContext, collaborators: MergeChecksDeps) {
  const { deps, state } = ctx;
  const { reviewer, lane, carryChecks } = collaborators;

  /** Leave the run for a person instead of merging, with why. Not ok, so the flow stops here. */
  async function holdMerge(reason: string, error: string): Promise<ActionResult> {
    await deps.record({ state: 'waiting_human', failureReason: reason });
    // Why runs stop being unattended: the reason is the event, per repository.
    await ctx.count(
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
    const pr = ctx.pullRequest();
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
    const change = await collaborators.classifyHead();
    if (
      change?.sha === sha &&
      change.risk.level === 'high' &&
      deps.autoMerge !== 'all' &&
      !(await deps.mergeApproved?.(sha))
    ) {
      return holdMerge(
        MERGE_HOLD_REASONS.highRisk,
        `Not merged: the change is high risk (${change.risk.reasons.join('; ')}). This factory merges only low-risk changes by itself.`,
      );
    }
    return null;
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
    await ctx.count(
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
    await ctx.count(
      { ...state.metrics, mergeSentBack: state.metrics.mergeSentBack + 1 },
      { event: `merge_sent_back_${why}` },
    );
    const metadata: Record<string, unknown> = { outcome: 'sent_back', why, feedback };
    if (regenerate) metadata.regenerate = regenerate;
    return { ok: true, output: 'sent_back', metadata };
  }

  return { holdMerge, mergeHeld, mergeRoundToImplementer, sentBack };
}

/** What the merge step is given besides the provider's context. */
interface MergeStepDeps {
  checks: ReturnType<typeof createMergeChecks>;
  lane: MergeLane;
  proof: ReturnType<typeof createProofGate>;
  ci: ReturnType<typeof createFactoryCiActions>;
  stacking: ReturnType<typeof createStacking>;
  carryChecks(from: string, to: string): Promise<void>;
  enterMerge(): Promise<void>;
}

/** The `merge` step: the gate, then a batch, GitHub's merge queue, or a merge pinned to the proved head. */
export function createMergeStep(ctx: ProviderContext, collaborators: MergeStepDeps) {
  const { deps, scope, state } = ctx;
  const { checks, lane, proof, ci, stacking } = collaborators;

  /**
   * The head to merge once the branch has its base and its checks are green
   * there (green on an old base proves nothing about the base as it is now),
   * or the result `merge` ends with instead.
   */
  async function upToDate(opts: MergeOpts, sha: string): Promise<string | ActionResult> {
    const current = await lane.bringUpToDate();
    if (current.kind === 'failed') return { ok: false, error: current.error };
    if (current.kind === 'sent-back') return checks.sentBack(current.why, current.feedback);
    for (const step of current.carried) await collaborators.carryChecks(step.from, step.to);
    if (current.sha === sha) return sha;
    return (await checks.mergeHeld(opts, current.sha)) ?? current.sha;
  }

  /**
   * Merge `sha` through GitHub's merge queue. Taken out of the queue, the
   * branch is brought up to date here, so what failed with the base shows on
   * the pull request's own checks and goes to the implementing agent.
   */
  async function throughQueue(opts: MergeOpts, sha: string): Promise<ActionResult> {
    if (opts.requireRegressionProof !== false) {
      const config = opts.regressionProof;
      if (!config || config.rules.length === 0) return PROOF_NOT_CONFIGURED;
      const held = await proof.proofOfHead(config, sha);
      if ('refused' in held) return held.refused;
    }
    const end = await lane.throughQueue(sha);
    if (end.kind === 'merged') {
      await deps.record({ state: 'merged', currentStep: null });
      return { ok: true, output: 'merged', metadata: { outcome: 'merged', via: 'merge-queue' } };
    }
    if (end.kind === 'failed') return { ok: false, error: end.error };
    const current = await lane.bringUpToDate();
    if (current.kind === 'sent-back') return checks.sentBack(current.why, current.feedback);
    return {
      ok: false,
      error:
        current.kind === 'failed'
          ? `GitHub's merge queue removed the pull request, and it could not be brought up to date: ${current.error}`
          : "GitHub's merge queue removed the pull request, though its checks pass on the current base.",
    };
  }

  /**
   * Lead the batch the gate gathered for this `merge`, when there is one and
   * the base branch allows it: the leader's result, or null for the serial
   * path (no batch, or the batch left this run to it).
   */
  async function asBatchLeader(opts: MergeOpts, baseBranch: string): Promise<ActionResult | null> {
    const batch = opts.execution?.batch;
    if (!batch || batch.members.length === 0 || !deps.queue) return null;
    // A regenerable change is merged alone (D11): the others wait for the next batch.
    if (opts.regenerate) {
      for (const member of batch.members) batch.settle(member.holder, { status: 'requeued' });
      return null;
    }
    const self = await deps.queue.memberOf(scope.runId, null, { repo: scope.repo, baseBranch });
    if (!self) {
      for (const member of batch.members) batch.settle(member.holder, { status: 'requeued' });
      return null;
    }
    const verdict = await mergeAsBatch({
      queue: deps.queue,
      batch,
      self,
      gates: {
        requireReview: opts.requireReview !== false,
        requireRegressionProof: opts.requireRegressionProof !== false,
      },
      onStats: (stats, flake) =>
        ctx.count(withBatchStats(state.metrics, stats, flake), { event: 'batch_ended' }),
    });
    if (!verdict || verdict.kind === 'requeued') return null;
    if (verdict.kind === 'sent_back') return checks.sentBack(verdict.why, verdict.feedback);
    if (verdict.kind === 'held') {
      return checks.holdMerge(MERGE_HOLD_REASONS.queue, `Not merged: ${verdict.reason}.`);
    }
    await deps.record({ state: 'merged', currentStep: null });
    await deps.queue.deleteMergedBranch(self);
    return {
      ok: true,
      output: 'merged',
      metadata: { outcome: 'merged', sha: verdict.sha, batched: true },
    };
  }

  /**
   * What `merge` settles before it looks at the pull request (factory-integration):
   * a stacked run whose blocker landed is retargeted and integrated first
   * (D10), and a regenerable change is recorded as one (merged alone, D9).
   */
  async function beforeMerge(opts: MergeOpts): Promise<ActionResult | null> {
    state.atMerge = true;
    await collaborators.enterMerge();
    const retarget = await stacking.retargetIfLanded();
    if (retarget === 'retargeted') {
      return checks.sentBack(
        'conflict',
        'The pull request it was stacked on merged: this pull request now targets the default branch, and the base is merged in before it merges.',
      );
    }
    if (typeof retarget === 'object') {
      return checks.holdMerge(MERGE_HOLD_REASONS.stacked, retarget.error);
    }
    if (opts.regenerate && state.regenerating !== opts.regenerate) {
      state.regenerating = opts.regenerate;
      await deps.record({ regenerateNode: opts.regenerate });
    }
    return null;
  }

  /**
   * The merge gate: merge only a pull request head that passed the flow's
   * review and has a passing proof of that exact commit, pinned to it. Runs
   * the flow's proof when none is held.
   */
  return async function provedMerge(opts: MergeOpts): Promise<ActionResult> {
    const settled = await beforeMerge(opts);
    if (settled) return settled;
    const pr = ctx.pullRequest();
    if (!pr) return ci.merge(opts);
    const head = await deps.github.pullRequests.pullHead(pr);
    if (head.isErr()) {
      return { ok: false, error: head.error.message, metadata: { kind: head.error.kind } };
    }
    const held = await checks.mergeHeld(opts, head.value.sha);
    if (held) return held;
    const batched = await asBatchLeader(opts, head.value.baseRef);
    if (batched) return batched;

    // Where the base branch requires GitHub's merge queue, GitHub tests the
    // change on the current base and merges it: the factory enqueues and follows.
    const queue = await deps.github.pullRequests.mergeQueueRequired(pr, head.value.baseRef);
    if (queue.isErr()) {
      return { ok: false, error: queue.error.message, metadata: { kind: queue.error.kind } };
    }
    const sha = queue.value ? head.value.sha : await upToDate(opts, head.value.sha);
    if (typeof sha !== 'string') return sha;
    if (queue.value) return throughQueue(opts, sha);
    if (opts.requireRegressionProof === false) {
      // A reviewed commit is merged as that commit; without the review gate, as before.
      return opts.requireReview === false ? ci.merge(opts) : ci.merge({ ...opts, sha });
    }
    // A proof without rules proves nothing: no merge, whatever it answered.
    const config = opts.regressionProof;
    if (!config || config.rules.length === 0) return PROOF_NOT_CONFIGURED;
    const proved = await proof.proofOfHead(config, sha);
    if ('refused' in proved) return proved.refused;
    // Auto-merge only on the proved commit whose check GitHub can hold.
    return ci.merge({
      ...opts,
      sha,
      autoMergeWhenHeld: await proof.checkOnGithub(proved.held),
    });
  };
}
