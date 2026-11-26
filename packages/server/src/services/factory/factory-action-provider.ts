/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: application
 *
 * The factory's server `ActionProvider` (change factory-flow-execution, task
 * 3.1): how a flow's steps act when the server runs them as the factory's
 * enabler.
 *
 * - `spawn_agent` starts a thread on the enabler's runner (the caller's
 *   `launch`, i.e. `startThreadOnRunner`, so runner isolation and the
 *   project ↔ runner binding apply) and resolves from the thread's durable
 *   terminal status. A resumed run (after a server restart) does not start
 *   work twice:
 *   - With the engine's journal (change workflow-dag-engine, D6), a finished
 *     step is not called again, and an unfinished one gets what it
 *     checkpointed (`StepCheckpoint`): the thread it started, the launch it
 *     was making, or the follow-up it was sending; it adopts that work.
 *   - Without journal rows (a run from before the journal, or one a retry or
 *     take-over reopened), agent steps are numbered in call order and the
 *     N-th finds the thread `threadIds[N]` recorded (`legacyReplay`).
 * - Every agent step after the first CONTINUES the run's first thread with a
 *   follow-up message (when `continuation` is given), so a CI fix keeps the
 *   context of the implementation instead of starting cold. Such a step is
 *   recorded under the same thread id again.
 * - `git_commit` / `git_push` are acknowledged: the server has no checkout, the
 *   agent commits and pushes on the runner. `create_pr` finds the pull request
 *   the agent opened from the run's branch.
 * - `wait_ci` / `merge` act on that pull request with the App token capped by
 *   the enabler (`factory-ci-actions.ts`).
 * - `review` judges the pull request's head commit on a NEW read-only thread
 *   (`factory-review.ts`), never a follow-up on the implementing thread. Review
 *   threads are not recorded in `threadIds`, which stays the implementing
 *   agent's steps; each verdict keeps its thread id.
 * - `triage` decides on its own read-only thread whether the issue can be
 *   worked unattended and writes the run's contract (`factory-triage.ts`).
 * - `run_command` and `integrate` run on the runner in the run's checkout
 *   (`factory-step-runner.ts`, `factory-integrate.ts`), never on the server.
 * - `set_status`, `set_stage` and approvals are refused: the run has no thread
 *   of its own and nobody to approve.
 */

import { EMPTY_INTEGRATE_CONFIG } from '@funny/workflows';
import type { ActionProvider, ActionResult, ApprovalDecision } from '@funny/workflows/compiler';
import { errAsync } from 'neverthrow';

import { log } from '../../lib/logger.js';
import { createApprovalMoves } from './factory-action-provider/approvals.js';
import { createActionCore } from './factory-action-provider/core.js';
import { createHeadChecks } from './factory-action-provider/head.js';
import { createMergeHolds } from './factory-action-provider/holds.js';
import { createMergeStep } from './factory-action-provider/merge.js';
import { createPullRequestStep } from './factory-action-provider/pr.js';
import { createProofGate } from './factory-action-provider/proof.js';
import { createRunRoles } from './factory-action-provider/roles.js';
import {
  countCiResult,
  refused,
  type FactoryActionProviderDeps,
} from './factory-action-provider/shared.js';
import { createStepThreads, runCommandStep } from './factory-action-provider/threads.js';
import { createFactoryCiActions } from './factory-ci-actions.js';
import { createEarlyIntegration, createWorkspaceLock } from './factory-early-integration.js';
import { createFactoryIntegrate } from './factory-integrate.js';
import { createMergeLane } from './factory-merge-lane.js';
import type { FactoryRunStage } from './factory-runs.js';
import { createStacking } from './factory-stacking.js';

export {
  countCiResult,
  MAX_MERGE_ROUNDS_TO_AGENT,
  MAX_STALE_MERGES,
  MERGE_HOLD_REASONS,
  NO_CHANGE_LINE,
  NO_CHANGE_REASON,
  NOT_PUSHED_REASON,
  NO_CHANGE_TRIAGE_LABEL,
  type FactoryActionProviderDeps,
  type FactoryContinuation,
  type FactoryLaunchBody,
  type FactoryRunScope,
  type FactoryThreadMode,
  type IssueRunScope,
  type StepAgentBody,
  type StepOptionsEntry,
} from './factory-action-provider/shared.js';
export type { FactoryProofDeps } from './factory-proof-runner.js';
export { regressionTestRequired } from './factory-proof-runner.js';

export function createFactoryActionProvider(deps: FactoryActionProviderDeps): ActionProvider {
  const core = createActionCore(deps);
  const { scope, threadIds, state, count, pullRequest } = core;
  /** A run stacked on its blocker's branch (D10): its base until the blocker lands. */
  const stacking = createStacking({
    stackedOn: deps.stackedOn ?? null,
    defaultBranch: deps.defaultBranch,
    blockerState: deps.blockerState,
    retarget: deps.retarget,
    record: (input) => deps.record(input),
    signal: deps.signal,
  });
  const ci = createFactoryCiActions({
    prs: deps.github.pullRequests,
    pullRequest,
    signal: deps.signal,
    markMerged: () => deps.record({ state: 'merged', currentStep: null }),
  });
  const lane = createMergeLane({
    prs: deps.github.pullRequests,
    pullRequest,
    branch: scope.branch,
    signal: deps.signal,
    waitChecks: async () => {
      const result = await ci.waitCi(state.lastWaitCi);
      const verdict = result.metadata?.verdict;
      await count(countCiResult(state.metrics, result), {
        event: 'ci_round',
        verdict: String(verdict),
      });
      return result;
    },
  });
  const { agentStep, worktreeBase } = createStepThreads(core, { stacking });
  const enterStage = async (stage: FactoryRunStage) =>
    deps.enterStage
      ? deps.enterStage(stage)
      : deps.record({ state: stage === 'review' ? 'reviewing' : 'merging' });
  const { classifyHead, publishVerdict, publishCarriedStatus } = createHeadChecks(core, {
    triage: () => triager.current(),
  });
  const { triager, reviewer } = createRunRoles(core, {
    worktreeBase,
    classifyHead,
    publishVerdict,
    publishCarriedStatus,
    enterStage,
    integrationOf: (sha) => integration.integrationOf(sha),
    diffBase: () => stacking.diffBase(),
  });
  const proof = createProofGate(core, { lane });
  const approvals = createApprovalMoves(core, { classifyHead });
  /**
   * `to` merges only the base branch into `from` and settled nothing: what was
   * judged of `from` holds for `to`, its review, its proof, and a member's
   * approval to merge it although it is high risk. Without the approval, every
   * base merge of an approved commit would wait for a person again.
   */
  async function carryChecks(from: string, to: string): Promise<void> {
    await reviewer.carry(from, to);
    await proof.carryProof(from, to);
    await approvals.carryApprovalAcrossBaseMerge(from, to);
  }
  const holds = createMergeHolds(core, {
    reviewer,
    lane,
    riskReasons: approvals.riskReasons,
    carryChecks,
  });
  const { provedMerge } = createMergeStep(core, {
    holds,
    proof,
    lane,
    ci,
    stacking,
    enterStage,
    carryChecks,
  });
  const { createPr } = createPullRequestStep(core, {
    base: () => stacking.base(),
    retarget: deps.retarget,
  });

  // Triage and review judge a change against the run's issue. A run without
  // one never reaches them: its flow is refused when it has such a step
  // (`validateFlowForSubject`), and the step entries below refuse again. The
  // roles are still built, on a scope whose issue number is never used.
  const needsIssue = (step: string): ActionResult => ({
    ok: false,
    error: `The ${step} step needs an issue, and this run has none.`,
  });
  /** The run's checkout: one step at a time, an early integration included (D8). */
  const workspace = createWorkspaceLock();
  const early = createEarlyIntegration({
    lock: workspace,
    integrate: () => integration.integrate(),
    atMerge: () => state.atMerge,
    toImplementer: (feedback) => conflictToImplementer(feedback),
    markPending: (at) => deps.record({ integrationPendingAt: at }),
  });
  deps.registerEarly?.(early);
  /** A step that works in the run's checkout: it holds the lock; a pending integration follows it. */
  const inCheckout = <T>(fn: () => Promise<T>): Promise<T> => {
    state.atMerge = false;
    return workspace.hold(fn, () => early.afterStep());
  };

  /** An early integration's conflict, as a follow-up on the implementing thread, waited for. */
  async function conflictToImplementer(feedback: string): Promise<void> {
    const threadId = threadIds[0];
    const continuation = deps.continuation;
    if (!threadId || !continuation) return;
    const completedAt = await continuation.completedAt(threadId);
    const sentAt = new Date().toISOString();
    const sent = await continuation.followUp(threadId, feedback);
    if (sent.isErr()) return;
    await count(
      { ...state.metrics, agentFixes: state.metrics.agentFixes + 1 },
      { event: 'agent_fix_early' },
    );
    await deps.waitThread(threadId, deps.signal, { completedAt, sentAt });
  }

  const integration = createFactoryIntegrate({
    steps: deps.steps,
    threadId: () => threadIds[0],
    branch: scope.branch,
    // A stacked run integrates its blocker's branch until the blocker landed.
    defaultBranch: () => stacking.base() ?? errAsync({ message: 'the base branch is unknown' }),
    config: deps.integrateConfig ?? EMPTY_INTEGRATE_CONFIG,
    signal: deps.signal,
    metrics: () => state.metrics,
    count: (next, attributes) => count(next, attributes),
    carry: (from, to) => carryChecks(from, to),
    toImplementer: () => holds.mergeRoundToImplementer(),
  });
  return {
    spawnAgent: (opts) => inCheckout(() => agentStep(opts)),

    async gitCommit() {
      return { ok: true, output: 'The agent commits on the runner.' };
    },

    async gitPush() {
      return { ok: true, output: 'The agent pushes on the runner.' };
    },

    createPr,

    async waitCi(opts) {
      state.lastWaitCi = {
        timeoutMs: opts.timeoutMs,
        intervalMs: opts.intervalMs,
        requiredChecks: opts.requiredChecks,
      };
      await deps.record({ state: 'waiting_ci' });
      // When the commit's checks start: the report is ready before the review,
      // and the reviewer starts on this commit without waiting for green
      // (D7). A review of an older commit is stopped and its result dropped.
      const head = await classifyHead();
      if (head && opts.earlyReview && scope.issueNumber !== null) {
        await reviewer.startEarly(head.sha, opts.earlyReview);
      }
      const result = await ci.waitCi(opts);
      const verdict = result.metadata?.verdict;
      await count(countCiResult(state.metrics, result), {
        event: 'ci_round',
        verdict: String(verdict),
      });
      if (!result.ok) return result;
      // A stacked run waits here for its blocker (D10), holding no merge slot.
      const stuck = await stacking.waitForBlocker();
      return stuck ? { ok: false, error: stuck, metadata: { outcome: 'blocker-gone' } } : result;
    },

    merge: async (opts) => (scope.issueNumber === null ? needsIssue('merge') : provedMerge(opts)),

    regressionProof: async (opts) =>
      scope.issueNumber === null ? needsIssue('regression_proof') : proof.runRegressionProof(opts),

    review: async (opts) =>
      scope.issueNumber === null ? needsIssue('review') : reviewer.review(opts),

    triage: async (opts) =>
      scope.issueNumber === null ? needsIssue('triage') : triager.triage(opts),

    async notify(opts) {
      log.info('Issue factory flow notice', {
        namespace: 'factory',
        runId: scope.runId,
        level: opts.level ?? 'info',
        message: opts.message,
      });
      return { ok: true };
    },

    runCommand: (opts) => inCheckout(() => runCommandStep(core, opts)),

    integrate: () => inCheckout(() => integration.integrate()),

    async setStatus() {
      return refused('set_status', 'the run has no thread of its own.');
    },

    async setStage() {
      return refused('set_stage', 'the run has no thread of its own.');
    },

    async requestApproval(): Promise<ApprovalDecision> {
      return { decision: 'reject', reason: 'Approvals are not available in a factory flow.' };
    },
  };
}
