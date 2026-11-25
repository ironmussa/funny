/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: application
 *
 * The `merge` step of the factory's `ActionProvider`: a pull request head
 * that passed the flow's gates, brought up to date with its base, merged
 * alone, through GitHub's merge queue or as the leader of a batch.
 */

import type { ActionResult, MergeOpts } from '@funny/workflows/compiler';

import { log } from '../../../lib/logger.js';
import { isString } from '../../../lib/value-guards.js';
import type { createFactoryCiActions } from '../factory-ci-actions.js';
import { mergeAsBatch } from '../factory-merge-batch.js';
import type { createMergeLane } from '../factory-merge-lane.js';
import { withBatchStats } from '../factory-queue-port.js';
import type { FactoryRunStage } from '../factory-runs.js';
import type { createStacking } from '../factory-stacking.js';
import type { ActionCore } from './core.js';
import type { createMergeHolds } from './holds.js';
import type { createProofGate } from './proof.js';
import { MAX_STALE_MERGES, MERGE_HOLD_REASONS, PROOF_NOT_CONFIGURED } from './shared.js';

/** What the merge step reads of the rest of the provider. */
interface MergeStepLinks {
  holds: ReturnType<typeof createMergeHolds>;
  proof: Pick<ReturnType<typeof createProofGate>, 'proofOfHead' | 'checkOnGithub'>;
  lane: ReturnType<typeof createMergeLane>;
  ci: ReturnType<typeof createFactoryCiActions>;
  stacking: Pick<ReturnType<typeof createStacking>, 'retargetIfLanded'>;
  enterStage(stage: FactoryRunStage): Promise<void>;
  carryChecks(from: string, to: string): Promise<void>;
}

/** `merge`: the gates on entry, then the merge on the current base. */
export function createMergeStep(core: ActionCore, links: MergeStepLinks) {
  const { deps, scope, state, count, pullRequest } = core;
  const { holds, proof, lane, ci, stacking, enterStage, carryChecks } = links;
  const { holdMerge, mergeHeld, heldOnEntry, sentBack } = holds;
  const { proofOfHead, checkOnGithub } = proof;
  /**
   * The head to merge once the branch has its base and its checks are green
   * there (green on an old base proves nothing about the base as it is now),
   * or the result `merge` ends with instead.
   */
  async function upToDate(opts: MergeOpts, sha: string): Promise<string | ActionResult> {
    const current = await lane.bringUpToDate();
    if (current.kind === 'failed') return { ok: false, error: current.error };
    if (current.kind === 'sent-back') return sentBack(current.why, current.feedback);
    for (const step of current.carried) await carryChecks(step.from, step.to);
    if (current.sha === sha) return sha;
    return (await mergeHeld(opts, current.sha)) ?? current.sha;
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
      const proof = await proofOfHead(config, sha);
      if ('refused' in proof) return proof.refused;
    }
    const end = await lane.throughQueue(sha);
    if (end.kind === 'merged') {
      await deps.record({ state: 'merged', currentStep: null });
      return { ok: true, output: 'merged', metadata: { outcome: 'merged', via: 'merge-queue' } };
    }
    if (end.kind === 'failed') return { ok: false, error: end.error };
    const current = await lane.bringUpToDate();
    if (current.kind === 'sent-back') return sentBack(current.why, current.feedback);
    return {
      ok: false,
      error:
        current.kind === 'failed'
          ? `GitHub's merge queue removed the pull request, and it could not be brought up to date: ${current.error}`
          : "GitHub's merge queue removed the pull request, though its checks pass on the current base.",
    };
  }

  /**
   * The merge gate: merge only a pull request head that passed the flow's
   * review and has a passing proof of that exact commit, pinned to it. Runs
   * the flow's proof when none is held.
   */
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
        count(withBatchStats(state.metrics, stats, flake), { event: 'batch_ended' }),
    });
    if (!verdict || verdict.kind === 'requeued') return null;
    if (verdict.kind === 'sent_back') return sentBack(verdict.why, verdict.feedback);
    if (verdict.kind === 'held') {
      return holdMerge(MERGE_HOLD_REASONS.queue, `Not merged: ${verdict.reason}.`);
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
    await enterStage('merge');
    const retarget = await stacking.retargetIfLanded();
    if (retarget === 'retargeted') {
      return sentBack(
        'conflict',
        'The pull request it was stacked on merged: this pull request now targets the default branch, and the base is merged in before it merges.',
      );
    }
    if (retarget !== 'not-stacked') return holdMerge(MERGE_HOLD_REASONS.stacked, retarget.error);
    if (opts.regenerate && state.regenerating !== opts.regenerate) {
      state.regenerating = opts.regenerate;
      await deps.record({ regenerateNode: opts.regenerate });
    }
    return null;
  }

  async function provedMerge(opts: MergeOpts): Promise<ActionResult> {
    const settled = await beforeMerge(opts);
    if (settled) return settled;
    const pr = pullRequest();
    if (!pr) return ci.merge(opts);
    const head = await deps.github.pullRequests.pullHead(pr);
    if (head.isErr()) {
      return { ok: false, error: head.error.message, metadata: { kind: head.error.kind } };
    }
    const held = await heldOnEntry(opts, head.value.sha, head.value.baseRef);
    if (held) return held;
    const batched = await asBatchLeader(opts, head.value.baseRef);
    if (batched) return batched;

    // Where the base branch requires GitHub's merge queue, GitHub tests the
    // change on the current base and merges it: the factory enqueues and follows.
    const queue = await deps.github.pullRequests.mergeQueueRequired(pr, head.value.baseRef);
    if (queue.isErr()) {
      return { ok: false, error: queue.error.message, metadata: { kind: queue.error.kind } };
    }
    if (queue.value) return throughQueue(opts, head.value.sha);
    return mergeOnCurrentBase(opts, head.value.sha);
  }

  /**
   * Merge the pull request once it is up to date, and again when GitHub
   * refused because a branch moved between the lane's look and its answer
   * (D1): that needs the base brought in and the checks, not a person. Any
   * other refusal ends the step as before.
   */
  async function mergeOnCurrentBase(opts: MergeOpts, head: string): Promise<ActionResult> {
    let from = head;
    for (let refusals = 1; ; refusals++) {
      const sha = await upToDate(opts, from);
      if (!isString(sha)) return sha;
      const merged = await mergeCommit(opts, sha);
      if (merged.ok || merged.metadata?.outcome !== 'not-mergeable') return merged;
      const moved = await lane.movedSince(sha);
      if (moved !== 'head' && moved !== 'base') return merged;
      await count(state.metrics, { event: `merge_refused_${moved}_moved` });
      if (refusals >= MAX_STALE_MERGES) {
        return holdMerge(
          MERGE_HOLD_REASONS.baseMoving,
          `Not merged: GitHub refused the merge ${MAX_STALE_MERGES} times, and each time the ${moved === 'base' ? 'base branch' : "pull request's head"} had moved. Retry the run when the branch is quiet.`,
        );
      }
      log.info('Issue factory merge refused while a branch moved: trying again', {
        namespace: 'factory',
        runId: scope.runId,
        sha,
        moved,
        refusals,
      });
      from = sha;
    }
  }

  /** Merge `sha`, which is up to date and green, behind the gates the flow asks for. */
  async function mergeCommit(opts: MergeOpts, sha: string): Promise<ActionResult> {
    if (opts.requireRegressionProof === false) {
      // A reviewed commit is merged as that commit; without the review gate, as before.
      return opts.requireReview === false ? ci.merge(opts) : ci.merge({ ...opts, sha });
    }
    // A proof without rules proves nothing: no merge, whatever it answered.
    const config = opts.regressionProof;
    if (!config || config.rules.length === 0) return PROOF_NOT_CONFIGURED;
    const proof = await proofOfHead(config, sha);
    if ('refused' in proof) return proof.refused;
    // Auto-merge only on the proved commit whose check GitHub can hold.
    return ci.merge({
      ...opts,
      sha,
      autoMergeWhenHeld: await checkOnGithub(proof.held),
    });
  }

  return { provedMerge };
}
