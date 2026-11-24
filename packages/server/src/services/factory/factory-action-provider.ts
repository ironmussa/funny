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

import {
  EMPTY_FACTORY_RUN_METRICS,
  contractOf,
  type FactoryRunMetrics,
} from '@funny/shared/contracts/factory';
import { EMPTY_INTEGRATE_CONFIG } from '@funny/workflows';
import type { ActionProvider, ActionResult, ApprovalDecision } from '@funny/workflows/compiler';
import { err, errAsync, ok } from 'neverthrow';
import { z } from 'zod';

import { log } from '../../lib/logger.js';
import { metric } from '../../lib/telemetry.js';
import { conflictToImplementer, createAgentStep } from './factory-action-provider-agent.js';
import type {
  FactoryActionProviderDeps,
  IssueRunScope,
  ProviderContext,
  ProviderState,
} from './factory-action-provider-deps.js';
import {
  createHeadChecks,
  createPrStep,
  readerOf,
  refused,
  runCommandStep,
} from './factory-action-provider-head.js';
import { createMergeChecks, createMergeStep } from './factory-action-provider-merge.js';
import { createProofGate } from './factory-action-provider-proof.js';
import { createFactoryCiActions } from './factory-ci-actions.js';
import { createEarlyIntegration, createWorkspaceLock } from './factory-early-integration.js';
import { createFactoryIntegrate } from './factory-integrate.js';
import { createMergeLane } from './factory-merge-lane.js';
import { prNumberOf } from './factory-pull-requests.js';
import { createFactoryReviewer } from './factory-review.js';
import type { FactoryRunStage } from './factory-runs.js';
import { createStacking } from './factory-stacking.js';
import { createFactoryTriage } from './factory-triage.js';

export type {
  FactoryActionProviderDeps,
  FactoryContinuation,
  FactoryRunScope,
  FactoryThreadMode,
  IssueRunScope,
  StepAgentBody,
  StepOptionsEntry,
} from './factory-action-provider-deps.js';
export { NO_CHANGE_LINE, NO_CHANGE_REASON } from './factory-action-provider-head.js';
export { MAX_MERGE_ROUNDS_TO_AGENT, MERGE_HOLD_REASONS } from './factory-action-provider-merge.js';
export type { FactoryProofDeps } from './factory-proof-runner.js';
export { regressionTestRequired } from './factory-proof-runner.js';

/** The label an issue gets when its run ended with no change: a person decides what is next. */
export const NO_CHANGE_TRIAGE_LABEL = 'needs-triage';

/** The verdicts `wait_ci` reports in its result metadata (`factory-ci-actions.ts`). */
const CI_VERDICT = z.enum(['green', 'no-checks', 'red', 'conflict', 'blocked', 'timeout']);

/** The counter a `wait_ci` verdict adds to, besides the round itself; null for a pass. */
const VERDICT_COUNTERS = {
  green: null,
  'no-checks': null,
  red: 'ciRed',
  conflict: 'conflicts',
  blocked: 'ciBlocked',
  timeout: 'ciTimeouts',
} satisfies Record<z.infer<typeof CI_VERDICT>, keyof FactoryRunMetrics | null>;

/** The counters after a reviewer event: a verdict counts as a review, a failing one also as a fail. */
function reviewCounted(metrics: FactoryRunMetrics, event: string): FactoryRunMetrics {
  if (event === 'review_pass') return { ...metrics, reviews: metrics.reviews + 1 };
  if (event === 'review_fail') {
    return { ...metrics, reviews: metrics.reviews + 1, reviewFails: metrics.reviewFails + 1 };
  }
  return metrics;
}

/**
 * The counters after one `wait_ci` result. A stop or a GitHub access error is
 * not a CI round (no verdict about the code), so it counts nothing.
 */
export function countCiResult(
  metrics: FactoryRunMetrics,
  result: ActionResult,
): FactoryRunMetrics | null {
  const verdict = CI_VERDICT.safeParse(result.metadata?.verdict);
  if (!verdict.success) return null;
  const next = { ...metrics, ciRounds: metrics.ciRounds + 1 };
  const counter = VERDICT_COUNTERS[verdict.data];
  if (counter) next[counter] += 1;
  return next;
}

const needsIssue = (step: string): ActionResult => ({
  ok: false,
  error: `The ${step} step needs an issue, and this run has none.`,
});

/** What the run's read-only roles (triage, review) are given besides the provider's context. */
interface RoleDeps {
  worktreeBase: () => Promise<
    { baseBranch?: string; baseFromRemote?: boolean } | { error: string }
  >;
  head: ReturnType<typeof createHeadChecks>;
  stacking: ReturnType<typeof createStacking>;
  integrationOf: ReturnType<typeof createFactoryIntegrate>['integrationOf'];
  enterStage(stage: FactoryRunStage): Promise<void>;
}

/**
 * The run's triage and review roles. They judge a change against the run's
 * issue. A run without one never reaches them: its flow is refused when it
 * has such a step (`validateFlowForSubject`), and the step entries refuse
 * again. The roles are still built, on a scope whose issue number is never used.
 */
function createRoles(ctx: ProviderContext, roles: RoleDeps) {
  const { deps, scope, state } = ctx;
  const roleScope: IssueRunScope = { ...scope, issueNumber: scope.issueNumber ?? 0 };
  const offBranch = deps.continuation?.followUpOffBranch;
  const askAgain =
    offBranch && deps.continuation
      ? { send: offBranch, completedAt: deps.continuation.completedAt }
      : undefined;
  const finalMessage = async (threadId: string) =>
    (await deps.lastThreadMessage?.(threadId)) ?? null;

  const triager = createFactoryTriage({
    scope: roleScope,
    issueUrl: scope.issueUrl ?? null,
    stored: deps.triage ?? null,
    since: deps.admittedAt ?? new Date(0).toISOString(),
    signal: deps.signal,
    launch: deps.launch,
    findLaunched: async (prefix, since) => (await deps.findTriageThread?.(prefix, since)) ?? null,
    waitThread: deps.waitThread,
    finalMessage,
    followUp: askAgain,
    worktreeBase: roles.worktreeBase,
    comment: async (body) => {
      const posted = await deps.github.commentOnIssue(readerOf(ctx), roleScope.issueNumber, body);
      return posted.isOk() ? ok(undefined) : err(posted.error.message);
    },
    busyPaths: deps.busyPaths,
    issueUpdatedAt: deps.issueUpdatedAt,
    issueText: deps.issueText,
    hold: deps.holdForPaths,
    split: deps.split,
    exclusive: deps.exclusive,
    record: deps.record,
    count: (event) => ctx.count(state.metrics, { event }),
  });

  const reviewer = createFactoryReviewer({
    scope: roleScope,
    issueUrl: scope.issueUrl ?? null,
    issueText: deps.issueText,
    reviews: deps.reviews ?? [],
    since: deps.admittedAt ?? new Date(0).toISOString(),
    signal: deps.signal,
    pullRequest: ctx.pullRequest,
    prUrl: () => state.prUrl,
    headSha: async () => {
      const pr = ctx.pullRequest();
      if (!pr) return err('The run has no pull request yet.');
      const head = await deps.github.pullRequests.pullHead(pr);
      return head.isOk() ? ok(head.value.sha) : err(head.error.message);
    },
    classify: roles.head.classifyHead,
    launch: deps.launch,
    findLaunched: async (prefix, since) => (await deps.findReviewThread?.(prefix, since)) ?? null,
    waitThread: deps.waitThread,
    finalMessage,
    followUp: askAgain,
    contract: () => contractOf({ triage: triager.current() }),
    abandon: deps.abandon,
    worktreeBase: roles.worktreeBase,
    otherPullRequests: deps.otherPullRequests,
    acquireSlot: deps.reviewSlot,
    publish: roles.head.publishVerdict,
    publishStatus: roles.head.publishCarriedStatus,
    record: deps.record,
    enterReview: () => roles.enterStage('review'),
    count: (event) => ctx.count(reviewCounted(state.metrics, event), { event }),
    integrationOf: (sha) => roles.integrationOf(sha),
    diffBase: () => roles.stacking.diffBase(),
  });

  return { triager, reviewer };
}

/** The provider's shared state at the start of an execution. */
function initialState(deps: FactoryActionProviderDeps): ProviderState {
  return {
    threadIds: [...deps.threadIds],
    prUrl: deps.prUrl,
    pendingLaunch: deps.launchStartedAt,
    metrics: { ...EMPTY_FACTORY_RUN_METRICS, ...deps.metrics },
    agentSteps: 0,
    lastProof: null,
    classified: null,
    regenerating: undefined,
    atMerge: false,
    lastWaitCi: {},
  };
}

export function createFactoryActionProvider(deps: FactoryActionProviderDeps): ActionProvider {
  const { scope } = deps;
  const state = initialState(deps);
  const ctx: ProviderContext = {
    deps,
    scope,
    state,
    /** Add to the run's counters and store them with the run. */
    async count(next, attributes) {
      if (!next) return;
      state.metrics = next;
      metric('factory.integration_event', 1, {
        type: 'sum',
        attributes: { ...attributes, repo: scope.repo },
      });
      await deps.record({ metrics: state.metrics });
    },
    pullRequest() {
      const number = prNumberOf(state.prUrl);
      if (number === null) return null;
      return {
        repo: scope.repo,
        number,
        branch: scope.branch,
        userId: scope.userId,
        projectId: scope.projectId,
      };
    },
  };
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
    pullRequest: ctx.pullRequest,
    signal: deps.signal,
    markMerged: () => deps.record({ state: 'merged', currentStep: null }),
  });

  /**
   * Where a worktree run's branch starts: the remote's default branch. Not
   * knowing it fails the step, since the runner would then start from whatever
   * the enabler's checkout has (run #227 opened a pull request with 11 commits
   * that were not the agent's).
   */
  async function worktreeBase(): Promise<
    { baseBranch?: string; baseFromRemote?: boolean } | { error: string }
  > {
    const base = stacking.base();
    if (scope.mode !== 'worktree' || !base) return {};
    const branch = await base;
    if (branch.isErr()) {
      return {
        error: `The agent could not start: the repository's default branch could not be read (${branch.error.message}).`,
      };
    }
    return { baseBranch: branch.value, baseFromRemote: true };
  }

  const enterStage = async (stage: FactoryRunStage) =>
    deps.enterStage
      ? deps.enterStage(stage)
      : deps.record({ state: stage === 'review' ? 'reviewing' : 'merging' });

  const head = createHeadChecks(ctx, () => triager.current());
  const { triager, reviewer } = createRoles(ctx, {
    worktreeBase,
    head,
    stacking,
    integrationOf: (sha) => integration.integrationOf(sha),
    enterStage,
  });

  /** The run's checkout: one step at a time, an early integration included (D8). */
  const workspace = createWorkspaceLock();
  const early = createEarlyIntegration({
    lock: workspace,
    integrate: () => integration.integrate(),
    atMerge: () => state.atMerge,
    toImplementer: (feedback) => conflictToImplementer(ctx, feedback),
    markPending: (at) => deps.record({ integrationPendingAt: at }),
  });
  deps.registerEarly?.(early);
  /** A step that works in the run's checkout: it holds the lock; a pending integration follows it. */
  const inCheckout = <T>(fn: () => Promise<T>): Promise<T> => {
    state.atMerge = false;
    return workspace.hold(fn, () => early.afterStep());
  };

  const integration = createFactoryIntegrate({
    steps: deps.steps,
    threadId: () => state.threadIds[0],
    branch: scope.branch,
    // A stacked run integrates its blocker's branch until the blocker landed.
    defaultBranch: () => stacking.base() ?? errAsync({ message: 'the base branch is unknown' }),
    config: deps.integrateConfig ?? EMPTY_INTEGRATE_CONFIG,
    signal: deps.signal,
    metrics: () => state.metrics,
    count: (next, attributes) => ctx.count(next, attributes),
    carry: (from, to) => carryChecks(from, to),
    toImplementer: () => checks.mergeRoundToImplementer(),
  });

  /**
   * `to` merges only the base branch into `from` and settled nothing: what was
   * judged of `from` holds for `to`, its review, its proof, and a member's
   * approval to merge it although it is high risk. Without the approval, every
   * base merge of an approved commit would wait for a person again.
   */
  async function carryChecks(from: string, to: string): Promise<void> {
    await reviewer.carry(from, to);
    await proof.carryProof(from, to);
    await deps.carryMergeApproval?.(from, to);
  }

  /** One look at the pull request's checks, counted as a CI round. */
  async function waitChecks(opts: Parameters<typeof ci.waitCi>[0]) {
    const result = await ci.waitCi(opts);
    const verdict = result.metadata?.verdict;
    await ctx.count(countCiResult(state.metrics, result), {
      event: 'ci_round',
      verdict: String(verdict),
    });
    return result;
  }

  const lane = createMergeLane({
    prs: deps.github.pullRequests,
    pullRequest: ctx.pullRequest,
    branch: scope.branch,
    signal: deps.signal,
    waitChecks: () => waitChecks(state.lastWaitCi),
  });
  const proof = createProofGate(ctx, (from, to) => lane.isBaseMergeOf(from, to));
  const checks = createMergeChecks(ctx, {
    reviewer,
    classifyHead: head.classifyHead,
    lane,
    carryChecks,
  });
  const provedMerge = createMergeStep(ctx, {
    checks,
    lane,
    proof,
    ci,
    stacking,
    carryChecks,
    enterMerge: () => enterStage('merge'),
  });
  const agentStep = createAgentStep(ctx, worktreeBase);

  return {
    spawnAgent: (opts) => inCheckout(() => agentStep(opts)),

    async gitCommit() {
      return { ok: true, output: 'The agent commits on the runner.' };
    },

    async gitPush() {
      return { ok: true, output: 'The agent pushes on the runner.' };
    },

    createPr: () => createPrStep(ctx),

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
      const classified = await head.classifyHead();
      if (classified && opts.earlyReview && scope.issueNumber !== null) {
        await reviewer.startEarly(classified.sha, opts.earlyReview);
      }
      const result = await waitChecks(opts);
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

    runCommand: (opts) => inCheckout(() => runCommandStep(ctx, opts)),

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
