/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: application
 *
 * The regression proof of the factory's `ActionProvider`: run on the runner,
 * published as a check, held for the commit it proved, and carried to a
 * commit that only merges the base into it.
 */

import type { ActionResult, RegressionProofOpts } from '@funny/workflows/compiler';

import { log } from '../../../lib/logger.js';
import { metric } from '../../../lib/telemetry.js';
import type { createMergeLane } from '../factory-merge-lane.js';
import {
  proofAllowsMerge,
  proofCheckOf,
  proofRecordOf,
  proveOnRunner,
  regressionTestRequired,
  type ProofResultBody,
} from '../factory-proof-runner.js';
import type { RegressionProofRecord } from '../factory-runs.js';
import type { ActionCore } from './core.js';
import { heldProofRecord, proofFailed, proofUnavailable, type HeldProof } from './shared.js';

/** What the proof gate reads of the rest of the provider. */
interface ProofGateLinks {
  lane: Pick<ReturnType<typeof createMergeLane>, 'isBaseMergeOf'>;
}

/** The run's regression proof: run, reused, held for a commit, carried. */
export function createProofGate(core: ActionCore, links: ProofGateLinks) {
  const { deps, scope, threadIds, state, count, pullRequest } = core;
  const { lane } = links;
  /** Run the proof on the runner, record and publish it, and map its verdict to the step's result. */
  async function runRegressionProof(opts: RegressionProofOpts): Promise<ActionResult> {
    if (!deps.proof) return proofUnavailable('the proof service is not configured.');
    const threadId = threadIds[0];
    if (!threadId) return proofUnavailable('no implementing thread.');
    const testRequired = regressionTestRequired(opts, deps.issueLabels ?? []);
    const reused = await reusedProof(testRequired);
    if (reused) return reused;
    const run = await proveOnRunner(deps.proof, threadId, opts, deps.signal);
    if (run.kind === 'unavailable') return proofUnavailable(run.why);
    return proofVerdict(run.result, testRequired);
  }

  /**
   * The passing proof the run already has of the pull request's head, held
   * again instead of proving the same commit twice: a commit's tests give the
   * same verdict, and a retry or a merge approval reruns the step on a head
   * that did not change. Null when there is none, so the proof runs.
   */
  /** The pull request's head commit now; null when there is no pull request or it cannot be read. */
  async function pullHeadSha(): Promise<string | null> {
    const pr = pullRequest();
    if (!pr) return null;
    const head = await deps.github.pullRequests.pullHead(pr);
    return head.isOk() ? head.value.sha : null;
  }

  async function reusedProof(testRequired: boolean): Promise<ActionResult | null> {
    const record = heldProofRecord(state.lastProof?.record ?? deps.storedProof, testRequired);
    if (!record || (await pullHeadSha()) !== record.headSha) return null;
    state.lastProof = {
      record,
      testRequired,
      ok: true,
      checkPublished: record.checkPublished === true,
    };
    // The check may not have reached GitHub the first time: auto-merge needs it.
    await checkOnGithub(state.lastProof);
    await count(state.metrics, { event: 'regression_proof_reused' });
    return {
      ok: true,
      output: record.verdict,
      metadata: { ...state.lastProof.record, reused: true },
    };
  }

  /**
   * Publish the proof as the `funny/regression-proof` check on its commit.
   * Best effort: a failure is logged and counted, and only means the factory
   * will not enable auto-merge on this commit.
   */
  async function publishCheck(proof: RegressionProofRecord, testRequired: boolean) {
    const pr = pullRequest();
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
    const meta = { ...proofRecord };
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
      await count(state.metrics, { event });
      return { ok: true, output: result.verdict, metadata: meta };
    }
    await count(state.metrics, { event: 'regression_proof_fail' });
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
    if (provedSha && provedSha !== sha && (await lane.isBaseMergeOf(provedSha, sha))) {
      await carryProof(provedSha, sha);
    }
    if (state.lastProof?.record.headSha !== sha) {
      return {
        refused: {
          ok: false,
          error: `Regression proof unavailable: the pull request head ${sha} is not the proved commit ${state.lastProof?.record.headSha ?? '(none)'}.`,
        },
      };
    }
    return { held: state.lastProof };
  }

  /**
   * The passing proof of `from` holds for `to`: the merge lane made `to` by
   * merging only the base branch into `from`, and its checks passed there. The
   * proof's tests ran on the implementing agent's worktree, which stays at
   * `from`, so proving `to` again would only prove `from` once more.
   */
  async function carryProof(from: string, to: string): Promise<void> {
    if (!state.lastProof?.ok || state.lastProof.record.headSha !== from) return;
    const record: RegressionProofRecord = {
      ...state.lastProof.record,
      headSha: to,
      carriedFrom: state.lastProof.record.carriedFrom ?? from,
      checkPublished: false,
    };
    state.lastProof = { ...state.lastProof, record, checkPublished: false };
    await deps.record({ regressionProof: record });
    await count(state.metrics, { event: 'regression_proof_carried' });
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
