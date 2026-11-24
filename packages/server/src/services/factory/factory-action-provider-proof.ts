/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: application
 *
 * The regression proof of the factory's `ActionProvider`
 * (`factory-action-provider.ts`): run on the runner, published as the
 * `funny/regression-proof` check, held for the merge gate, reused for a head
 * that did not change and carried to a base merge that settled nothing.
 */

import type { ActionResult, RegressionProofOpts } from '@funny/workflows/compiler';

import { log } from '../../lib/logger.js';
import { metric } from '../../lib/telemetry.js';
import type { HeldProof, ProviderContext } from './factory-action-provider-deps.js';
import {
  proofAllowsMerge,
  proofCheckOf,
  proofRecordOf,
  proveOnRunner,
  regressionTestRequired,
  type ProofResultBody,
} from './factory-proof-runner.js';
import type { RegressionProofRecord } from './factory-runs.js';

/**
 * A proof the agent can fix (its test): the flows retry it with the agent.
 * Matched by `should_retry: "$contains(error, 'Regression proof failed')"`.
 */
const proofFailed = (why: string): ActionResult => ({
  ok: false,
  error: `Regression proof failed: ${why}`,
});

/** A proof that could not run or decide (runner, setup, time): no agent fix is tried. */
const proofUnavailable = (why: string): ActionResult => ({
  ok: false,
  error: `Regression proof unavailable: ${why}`,
});

/** A stored proof that names its commit and whose verdict allows a merge; null otherwise. */
function heldProofRecord(
  record: RegressionProofRecord | null | undefined,
  testRequired: boolean,
): RegressionProofRecord | null {
  return record?.headSha && proofAllowsMerge(record, testRequired) ? record : null;
}

/** What the proof needs of the merge lane: whether `to` only merged the base into `from`. */
type IsBaseMergeOf = (from: string, to: string) => Promise<boolean>;

export function createProofGate(ctx: ProviderContext, isBaseMergeOf: IsBaseMergeOf) {
  const { deps, scope, state } = ctx;

  /** Run the proof on the runner, record and publish it, and map its verdict to the step's result. */
  async function runRegressionProof(opts: RegressionProofOpts): Promise<ActionResult> {
    if (!deps.proof) return proofUnavailable('the proof service is not configured.');
    const threadId = state.threadIds[0];
    if (!threadId) return proofUnavailable('no implementing thread.');
    const testRequired = regressionTestRequired(opts, deps.issueLabels ?? []);
    const reused = await reusedProof(testRequired);
    if (reused) return reused;
    const run = await proveOnRunner(deps.proof, threadId, opts, deps.signal);
    if (run.kind === 'unavailable') return proofUnavailable(run.why);
    return proofVerdict(run.result, testRequired);
  }

  /** The pull request's head commit now; null when there is no pull request or it cannot be read. */
  async function pullHeadSha(): Promise<string | null> {
    const pr = ctx.pullRequest();
    if (!pr) return null;
    const head = await deps.github.pullRequests.pullHead(pr);
    return head.isOk() ? head.value.sha : null;
  }

  /**
   * The passing proof the run already has of the pull request's head, held
   * again instead of proving the same commit twice: a commit's tests give the
   * same verdict, and a retry or a merge approval reruns the step on a head
   * that did not change. Null when there is none, so the proof runs.
   */
  async function reusedProof(testRequired: boolean): Promise<ActionResult | null> {
    const record = heldProofRecord(state.lastProof?.record ?? deps.storedProof, testRequired);
    if (!record || (await pullHeadSha()) !== record.headSha) return null;
    const held: HeldProof = {
      record,
      testRequired,
      ok: true,
      checkPublished: record.checkPublished === true,
    };
    state.lastProof = held;
    // The check may not have reached GitHub the first time: auto-merge needs it.
    await checkOnGithub(held);
    await ctx.count(state.metrics, { event: 'regression_proof_reused' });
    return { ok: true, output: record.verdict, metadata: { ...held.record, reused: true } };
  }

  /**
   * Publish the proof as the `funny/regression-proof` check on its commit.
   * Best effort: a failure is logged and counted, and only means the factory
   * will not enable auto-merge on this commit.
   */
  async function publishCheck(proof: RegressionProofRecord, testRequired: boolean) {
    const pr = ctx.pullRequest();
    if (!pr || !proof.headSha) return false;
    const published = await deps.github.pullRequests.publishProofCheck(
      pr,
      proofCheckOf(proof, testRequired),
    );
    if (published.isOk()) return true;
    log.warn('Issue factory could not publish the regression proof check', {
      namespace: 'factory',
      runId: scope.runId,
      headSha: proof.headSha,
      error: published.error.message,
    });
    metric('factory.integration_event', 1, {
      type: 'sum',
      attributes: { event: 'regression_proof_check_unpublished', repo: scope.repo },
    });
    return false;
  }

  /** Publish the runner's verdict, record it on the run, and map it to the step's result. */
  async function proofVerdict(
    result: ProofResultBody,
    testRequired: boolean,
  ): Promise<ActionResult> {
    const proved = proofRecordOf(result);
    const checkPublished = await publishCheck(proved, testRequired);
    const proofRecord = { ...proved, checkPublished };
    await deps.record({ regressionProof: proofRecord });
    const meta: Record<string, unknown> = { ...proofRecord };
    // What the merge gate holds: only a proof that names its commit.
    if (proofRecord.headSha) {
      state.lastProof = {
        record: proofRecord,
        testRequired,
        ok: proofAllowsMerge(result, testRequired),
        checkPublished,
      };
    }

    if (proofAllowsMerge(result, testRequired)) {
      const event =
        result.verdict === 'pass' ? 'regression_proof_pass' : 'regression_proof_skipped';
      await ctx.count(state.metrics, { event });
      return { ok: true, output: result.verdict, metadata: meta };
    }
    await ctx.count(state.metrics, { event: 'regression_proof_fail' });
    if (result.verdict === 'skipped') {
      return {
        ...proofFailed('no regression test was added, but this issue needs one.'),
        metadata: meta,
      };
    }
    const finding = result.finding ?? 'failed';
    // Only a test the agent can fix is its to retry; an environment failure is not.
    return result.failureKind === 'test'
      ? { ...proofFailed(finding), metadata: meta }
      : { ...proofUnavailable(finding), metadata: meta };
  }

  /**
   * The passing proof of `sha`: the last one when it is of that commit and
   * passed, else a proof run now. Otherwise the result the merge step ends with.
   */
  async function proofOfHead(
    config: RegressionProofOpts,
    sha: string,
  ): Promise<{ held: HeldProof } | { refused: ActionResult }> {
    if (state.lastProof?.record.headSha !== sha || !state.lastProof.ok) {
      const proved = await runRegressionProof(config);
      if (!proved.ok) return { refused: proved };
    }
    // The proof ran in the implementer's checkout, which stays at the commit it
    // pushed: a head that only merged the base into that commit holds its proof
    // (a run resumed after the merge lane updated the branch).
    const provedSha = state.lastProof?.record.headSha;
    if (provedSha && provedSha !== sha && (await isBaseMergeOf(provedSha, sha))) {
      await carryProof(provedSha, sha);
    }
    const held = state.lastProof;
    if (held?.record.headSha !== sha) {
      return {
        refused: {
          ok: false,
          error: `Regression proof unavailable: the pull request head ${sha} is not the proved commit ${held?.record.headSha ?? '(none)'}.`,
        },
      };
    }
    return { held };
  }

  /**
   * The passing proof of `from` holds for `to`: the merge lane made `to` by
   * merging only the base branch into `from`, and its checks passed there. The
   * proof's tests ran on the implementing agent's worktree, which stays at
   * `from`, so proving `to` again would only prove `from` once more.
   */
  async function carryProof(from: string, to: string): Promise<void> {
    const last = state.lastProof;
    if (!last?.ok || last.record.headSha !== from) return;
    const record: RegressionProofRecord = {
      ...last.record,
      headSha: to,
      carriedFrom: last.record.carriedFrom ?? from,
      checkPublished: false,
    };
    state.lastProof = { ...last, record, checkPublished: false };
    await deps.record({ regressionProof: record });
    await ctx.count(state.metrics, { event: 'regression_proof_carried' });
  }

  /** Whether the proof's check is on GitHub, publishing it now when an earlier try failed. */
  async function checkOnGithub(proof: HeldProof): Promise<boolean> {
    if (proof.checkPublished) return true;
    const published = await publishCheck(proof.record, proof.testRequired);
    if (!published) return false;
    proof.checkPublished = true;
    proof.record = { ...proof.record, checkPublished: true };
    await deps.record({ regressionProof: proof.record });
    return true;
  }

  return { runRegressionProof, proofOfHead, carryProof, checkOnGithub };
}
