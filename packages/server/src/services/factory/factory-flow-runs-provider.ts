/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 *
 * The factory action provider of one flow run (`factory-flow-runs.ts`): its
 * scope, and the reads and writes its steps make through the host — the run's
 * issue, the merge queue and stacking (openspec factory-integration), the
 * merge approval, triage's paths, follow-ups and the regression proof.
 */

import type { ConcurrencyGate } from '@funny/pipelines';
import { lintCleanupSource } from '@funny/shared/contracts/factory';
import { err, ok, type Result } from 'neverthrow';

import { log } from '../../lib/logger.js';
import {
  createFactoryActionProvider,
  type FactoryActionProviderDeps,
  type FactoryContinuation,
  type FactoryProofDeps,
  type FactoryRunScope,
  NO_CHANGE_TRIAGE_LABEL,
} from './factory-action-provider.js';
import { createFactoryBatchesRepository } from './factory-batches.js';
import type { EarlyIntegration } from './factory-early-integration.js';
import type { RunSettlement } from './factory-flow-runs-settle.js';
import {
  DEFAULT_STAGE_LIMIT,
  findLaunchedThread,
  flowOf,
  followedUpSince,
  GONE_STATES,
  pathChecks,
  recordApprovalMove,
  stageGroup,
  threadCompletedAt,
  type FactoryFlowRunsDeps,
  type FactoryRunJob,
  type FlowTrace,
} from './factory-flow-runs-support.js';
import type { FactoryFlow } from './factory-flow.js';
import type { QueueMember } from './factory-merge-queue.js';
import { prNumberOf } from './factory-pull-requests.js';
import { createFactoryQueuePort, type FactoryQueuePort } from './factory-queue-port.js';
import { readWorkflowFiles } from './factory-readiness.js';
import {
  factoryRunBranch,
  threadsOf,
  type FactoryRunView,
  type UpdateRunInput,
} from './factory-runs.js';
import { getWatchedFactory, type projectAgentDefaults } from './factory-settings.js';
import type { BlockerState } from './factory-stacking.js';
import {
  lastAgentError,
  lastThreadMessage,
  type ThreadOutcome,
  type WaitAfter,
} from './factory-thread-waits.js';
import { busyPathsOf, type FactorySplitDeps } from './factory-triage.js';

/** What orders a run in the merge group: whether it blocks other runs, and its size. */
export interface MergeOrder {
  blocker: boolean;
  lines?: number;
}

/** What every run's provider of one `createFactoryFlowRuns` shares. */
export interface FlowRunsContext {
  deps: FactoryFlowRunsDeps;
  updateInFlight: RunSettlement['updateInFlight'];
  /** Each running flow's early integration (D8), by its run id. */
  earlyOf: Map<string, EarlyIntegration>;
  /** Each run's merge order, by its run id. */
  mergeOrder: Map<string, MergeOrder>;
  gate: ConcurrencyGate;
  waitThread: (threadId: string, signal: AbortSignal, after?: WaitAfter) => Promise<ThreadOutcome>;
  /** The triage and review threads' wait (`waitRoleThread` of the deps). */
  waitRoleThread: (
    threadId: string,
    signal: AbortSignal,
    after?: WaitAfter,
  ) => Promise<ThreadOutcome>;
}

/** What a run's steps are bound to; a run without an issue is titled by its trigger or flow. */
export const scopeOf = (job: FactoryRunJob): FactoryRunScope => ({
  runId: job.run.id,
  userId: job.factory.userId,
  projectId: job.factory.projectId,
  repo: job.repo,
  mode: job.mode,
  issueNumber: job.issue?.number ?? null,
  issueTitle: job.issue?.title ?? job.run.triggerName ?? flowOf(job),
  branch: factoryRunBranch(job.run),
  issueUrl: job.issue?.url,
});

/** Whether another queued run of the factory waits for this run's issue (it is a blocker). */
export async function blocksOthers(
  deps: FactoryFlowRunsDeps,
  job: FactoryRunJob,
): Promise<boolean> {
  // A run without an issue blocks nobody: blockers are issues.
  const issue = job.run.issueNumber;
  if (issue === null) return false;
  const queued = await deps.runs.queue(job.factory.id);
  if (queued.isErr()) return false;
  return queued.value.some((run) => run.waitReason?.blockers.includes(issue));
}

/** Where a stacked run's blocker stands (D10): merged, still worked on, or gone without merging. */
async function blockerStateOf(
  deps: FactoryFlowRunsDeps,
  stackedOn: FactoryRunView['stackedOn'],
): Promise<BlockerState> {
  if (!stackedOn) return 'merged';
  const blocker = (await deps.runs.get(stackedOn.runId)).unwrapOr(null);
  if (!blocker) return 'gone';
  if (blocker.state === 'merged') return 'merged';
  return GONE_STATES.has(blocker.state) ? 'gone' : 'in-flight';
}

/**
 * The merge queue for a run's `merge` step (openspec factory-integration
 * D2): absent where the GitHub side cannot build per-enabler providers.
 * A member that lands is recorded merged on its own run, and its threads'
 * worktrees are cleaned up as its own flow would.
 */
function queueFor(ctx: FlowRunsContext, signal: AbortSignal): FactoryQueuePort | undefined {
  const { deps } = ctx;
  const integrationFor = deps.github.pullRequests.integrationFor;
  if (!integrationFor) return undefined;
  const run = async (runId: string) => (await deps.runs.get(runId)).unwrapOr(null);
  /** The default branch's GitHub Actions workflows, read as the leader's enabler; null if unreadable. */
  const readWorkflows = (leader: QueueMember) =>
    readWorkflowFiles(deps.github, {
      repo: leader.repo,
      ownerId: leader.userId,
      projectId: leader.projectId,
    });
  return createFactoryQueuePort({
    batches: deps.batches ?? createFactoryBatchesRepository(),
    run,
    factory: getWatchedFactory,
    record: async (runId, input) => {
      const live = await ctx.updateInFlight(runId, input);
      if (!live.isOk() || !live.value || input.state !== 'merged') return;
      if (deps.closeSuperseded) void deps.closeSuperseded(runId);
      if (!deps.cleanupMerged) return;
      const merged = await run(runId);
      const factory = merged ? await getWatchedFactory(merged.factoryId) : null;
      if (merged && factory) await deps.cleanupMerged(factory.userId, threadsOf(merged));
    },
    integrationFor: (owner) => integrationFor(owner),
    workflows: (leader) => readWorkflows(leader),
    signal,
  });
}

/** Following up on the run's threads, when this host can (`deps.followUp`). */
function continuationFor(
  deps: FactoryFlowRunsDeps,
  scope: FactoryRunScope,
): FactoryContinuation | undefined {
  const followUp = deps.followUp;
  if (!followUp) return undefined;
  return {
    // The run's branch: a worktree switched away refuses the step.
    followUp: (threadId, content, options) =>
      followUp(scope.userId, threadId, content, scope.branch, { ...options }),
    completedAt: threadCompletedAt,
    followedUpSince,
    // A reviewer's thread is on its own branch: no branch guard.
    followUpOffBranch: (threadId, content) => followUp(scope.userId, threadId, content),
  };
}

/** The regression proof on the enabler's runner, when this host runs one (`deps.proof`). */
function proofFor(deps: FactoryFlowRunsDeps, scope: FactoryRunScope): FactoryProofDeps | undefined {
  const proof = deps.proof;
  if (!proof) return undefined;
  return {
    startProof: (threadId, body) => proof(scope.userId, threadId).startProof(threadId, body),
    pollProof: (threadId, proofId) => proof(scope.userId, threadId).pollProof(threadId, proofId),
    cancelProof: async (threadId, proofId) =>
      proof(scope.userId, threadId).cancelProof?.(threadId, proofId),
  };
}

/** Point a run's pull request at `base` (a stacked run, once its blocker landed: D10). */
async function retargetRun(
  deps: FactoryFlowRunsDeps,
  job: FactoryRunJob,
  scope: FactoryRunScope,
  base: string,
): Promise<Result<void, string>> {
  // The pull request was opened during the flow: read where it is now.
  const live = (await deps.runs.get(job.run.id)).unwrapOr(null);
  const pr = prNumberOf(live?.prUrl ?? null);
  const retarget = deps.github.pullRequests.retarget;
  if (pr === null || !retarget) return err('the run has no pull request to retarget');
  const done = await retarget(
    { repo: scope.repo, number: pr, userId: scope.userId, projectId: scope.projectId },
    base,
  );
  return done.mapErr((e) => e.message);
}

/**
 * What a run's provider needs for openspec factory-integration: the merge
 * queue, stacking on a blocker (D10), early integration (D8) and the queue's
 * order by size (D11).
 */
function integrationDepsFor(
  ctx: FlowRunsContext,
  job: FactoryRunJob,
  scope: FactoryRunScope,
  signal: AbortSignal,
) {
  return {
    queue: queueFor(ctx, signal),
    stackedOn: job.run.stackedOn,
    blockerState: () => blockerStateOf(ctx.deps, job.run.stackedOn),
    retarget: (base: string) => retargetRun(ctx.deps, job, scope, base),
    registerEarly: (early: EarlyIntegration) => ctx.earlyOf.set(job.run.id, early),
    onChangeSize: (lines: number) => {
      const order = ctx.mergeOrder.get(job.run.id) ?? { blocker: false };
      ctx.mergeOrder.set(job.run.id, { ...order, lines });
    },
  };
}

/** The provider's reads and writes of the run's issue; they do nothing for a run without one. */
function issueDepsOf(deps: FactoryFlowRunsDeps, job: FactoryRunJob, scope: FactoryRunScope) {
  const reader = { repo: scope.repo, ownerId: scope.userId, projectId: scope.projectId };
  return {
    issueLabels: job.issue?.labels ?? [],
    issueUpdatedAt: async () => {
      if (scope.issueNumber === null) return null;
      const issue = await deps.github.getIssue(reader, scope.issueNumber);
      return issue.isOk() ? (issue.value.updatedAt ?? null) : null;
    },
    issueText: async () => {
      if (scope.issueNumber === null) return null;
      const text = await deps.github.issueText(reader, scope.issueNumber);
      return text.isOk() ? text.value : null;
    },
    releaseIssue: async () => {
      if (scope.issueNumber === null) return;
      const relabelled = await deps.github.relabelIssue(reader, scope.issueNumber, {
        remove: job.factory.label || undefined,
        add: NO_CHANGE_TRIAGE_LABEL,
      });
      if (relabelled.isErr()) {
        log.warn('Issue factory could not relabel an issue that ended with no change', {
          namespace: 'factory',
          runId: job.run.id,
          issue: scope.issueNumber,
          error: relabelled.error.message,
        });
      }
    },
  };
}

/**
 * What the factory's `split` setting needs, or nothing (comment the split):
 * part issues are opened as the App with the token capped by the enabler,
 * like every other write of the run, and queued with the run's own flow.
 */
function splitDepsOf(
  deps: FactoryFlowRunsDeps,
  job: FactoryRunJob,
  scope: FactoryRunScope,
): FactorySplitDeps | undefined {
  return job.factory.tooBig === 'split' ? splitDepsFor(deps, job, scope) : undefined;
}

/** Open, queue and release a split's parts, whatever the factory's `split` setting says. */
export function splitDepsFor(
  deps: FactoryFlowRunsDeps,
  job: FactoryRunJob,
  scope: FactoryRunScope,
): FactorySplitDeps | undefined {
  const open = deps.github.createIssue;
  const parent = scope.issueNumber;
  if (!open || parent === null) return undefined;
  const reader = { repo: scope.repo, ownerId: scope.userId, projectId: scope.projectId };
  return {
    openIssue: async (issue) => {
      const created = await open(reader, issue);
      return created.isOk() ? ok(created.value.number) : err(created.error.message);
    },
    queue: async (parts) => {
      if (parts.length === 0) return;
      const issueNumbers = parts.map((part) => part.number);
      const queued = await deps.runs.enqueue({
        factoryId: job.factory.id,
        issueNumbers,
        // The part's title, so its card names it before triage reads the issue.
        issueTitles: new Map(parts.map((part) => [part.number, part.title])),
        flowName: flowOf(job),
      });
      if (queued.isErr()) {
        log.warn('Issue factory could not queue the parts of a split issue', {
          namespace: 'factory',
          runId: job.run.id,
          issues: issueNumbers,
          error: queued.error.message,
        });
      }
    },
    release: async (complete) => {
      const relabelled = await deps.github.relabelIssue(reader, parent, {
        remove: job.factory.label || undefined,
        add: complete ? undefined : NO_CHANGE_TRIAGE_LABEL,
      });
      if (relabelled.isErr()) {
        log.warn('Issue factory could not take its label off a split issue', {
          namespace: 'factory',
          runId: job.run.id,
          issue: parent,
          error: relabelled.error.message,
        });
      }
    },
  };
}

/** The member's merge approval of the run, read from its row: the member approves while the run waits. */
function approvalDepsOf(
  deps: FactoryFlowRunsDeps,
  job: FactoryRunJob,
  scope: FactoryRunScope,
): Pick<
  FactoryActionProviderDeps,
  'mergeApproved' | 'mergeApproval' | 'onApprovalMoved' | 'noteApprovalGap' | 'carryMergeApproval'
> {
  return {
    mergeApproved: async (sha) => {
      const run = await deps.runs.get(job.run.id);
      return run.isOk() && run.value?.mergeApproval?.sha === sha;
    },
    mergeApproval: async () => {
      const run = await deps.runs.get(job.run.id);
      return run.isOk() ? (run.value?.mergeApproval ?? null) : null;
    },
    onApprovalMoved: (move) => recordApprovalMove(move, scope.projectId, job.run.issueNumber),
    noteApprovalGap: async (approved, gap) => {
      const noted = await deps.runs.noteApprovalGap(job.run.id, approved, gap);
      if (noted.isErr()) {
        log.warn('Issue factory could not record what changed since the approved commit', {
          namespace: 'factory',
          runId: job.run.id,
          approved,
          error: noted.error.message,
        });
      }
    },
    carryMergeApproval: async (from, to, move) => {
      const carried = await deps.runs.carryMergeApproval(job.run.id, from, to, move);
      if (carried.isErr()) {
        log.warn('Issue factory could not move the merge approval to the new commit', {
          namespace: 'factory',
          runId: job.run.id,
          from,
          to,
          error: carried.error.message,
        });
        return false;
      }
      return carried.value;
    },
  };
}

/** Triage's view of the other runs' paths, and its hold of the run behind them. */
function triageDepsOf(
  deps: FactoryFlowRunsDeps,
  job: FactoryRunJob,
  scope: FactoryRunScope,
  trace: FlowTrace,
): Pick<
  FactoryActionProviderDeps,
  'triage' | 'findTriageThread' | 'busyPaths' | 'holdForPaths' | 'exclusive'
> {
  return {
    triage: job.run.triage,
    findTriageThread: (titlePrefix, since) => findLaunchedThread(scope, titlePrefix, since, true),
    busyPaths: async () => {
      const others = await deps.runs.inFlight(job.factory.id);
      if (others.isErr()) return [];
      // A run parked for a member's approval holds no slot, so it is read apart (D6).
      const hold = job.factory.holdPathsAwaitingApproval ? { now: Date.now() } : null;
      const parked = hold ? await deps.runs.awaitingApproval(job.factory.id) : null;
      return busyPathsOf(
        [...others.value, ...(parked?.isOk() ? parked.value : [])],
        job.run.id,
        job.run.stackedOn?.runId ?? null,
        hold,
      );
    },
    holdForPaths: async (blockers) => {
      const held = await deps.runs.holdForPaths(job.run.id, blockers);
      if (held.isErr() || !held.value) return false;
      trace.held = true;
      return true;
    },
    exclusive: (work) => pathChecks.run(job.factory.id, work),
  };
}

/** The review step's thread and slot, and the other runs' pull requests it reads. */
function reviewDepsOf(
  ctx: FlowRunsContext,
  job: FactoryRunJob,
  scope: FactoryRunScope,
): Pick<
  FactoryActionProviderDeps,
  'reviews' | 'admittedAt' | 'findReviewThread' | 'reviewSlot' | 'otherPullRequests'
> {
  const { deps } = ctx;
  return {
    reviews: job.run.reviews,
    admittedAt: job.run.admittedAt ?? job.run.startedAt,
    findReviewThread: (titlePrefix, since) => findLaunchedThread(scope, titlePrefix, since, true),
    reviewSlot: async (holder, signal) => {
      const grant = await ctx.gate.acquire({
        group: stageGroup('review', job.factory.id),
        limit: DEFAULT_STAGE_LIMIT,
        holder: `${job.run.id}/review/${holder}`,
        signal,
        onWait: () => {},
      });
      return grant.kind === 'slot' ? grant.release : () => {};
    },
    otherPullRequests: async () => {
      const others = await deps.runs.inFlight(job.factory.id);
      if (others.isErr()) return [];
      return others.value.flatMap((other) =>
        other.id !== job.run.id && other.prUrl ? [other.prUrl] : [],
      );
    },
  };
}

/** One run's flow attempt, as its provider sees it. */
export interface RunAttempt {
  job: FactoryRunJob;
  scope: FactoryRunScope;
  controller: AbortController;
  trace: FlowTrace;
  flow: FactoryFlow;
  projectDefaults: Awaited<ReturnType<typeof projectAgentDefaults>>;
  /** What each agent step ran with, after the steps an earlier attempt recorded. */
  stepOptions: FactoryRunView['stepOptions'];
  /** The role threads the run started, after the ones an earlier attempt recorded. */
  roleThreads: FactoryRunView['roleThreads'];
  record: (input: UpdateRunInput) => Promise<void>;
  /** The run has no journal rows: it replays its recorded threads instead. */
  legacyReplay: boolean;
}

/** The factory action provider a run's flow executes with. */
export function createRunProvider(ctx: FlowRunsContext, attempt: RunAttempt) {
  const { deps } = ctx;
  const { job, scope, controller, record, flow } = attempt;
  return createFactoryActionProvider({
    projectDefaults: attempt.projectDefaults,
    // Read at every agent step: a change saved mid-run reaches the steps not started yet.
    stepOverrides: async () =>
      (await getWatchedFactory(job.factory.id))?.stepOverrides ?? job.factory.stepOverrides,
    recordStepOptions: async (entry) => {
      attempt.stepOptions.push(entry);
      await record({ stepOptions: [...attempt.stepOptions] });
    },
    recordRoleThread: async (role, threadId) => {
      if (attempt.roleThreads.some((entry) => entry.threadId === threadId)) return;
      attempt.roleThreads.push({ role, threadId, startedAt: new Date().toISOString() });
      await record({ roleThreads: [...attempt.roleThreads] });
    },
    scope,
    threadIds: job.run.threadIds,
    prUrl: job.run.prUrl,
    metrics: job.run.metrics,
    launchStartedAt: job.run.launchStartedAt,
    findLaunched: (titlePrefix, since) => findLaunchedThread(scope, titlePrefix, since),
    abandon: async (threadId) => deps.stopThreads?.(scope.userId, [threadId]),
    launch: (body) => deps.launch({ userId: scope.userId, body }),
    waitThread: ctx.waitThread,
    waitRoleThread: ctx.waitRoleThread,
    continuation: continuationFor(deps, scope),
    github: deps.github,
    ...integrationDepsFor(ctx, job, scope, controller.signal),
    defaultBranch: () =>
      deps.github.defaultBranch({
        repo: scope.repo,
        ownerId: scope.userId,
        projectId: scope.projectId,
      }),
    ...issueDepsOf(deps, job, scope),
    split: splitDepsOf(deps, job, scope),
    dropLabel: async () => splitDepsFor(deps, job, scope)?.release(true),
    sensitivePaths: job.factory.sensitivePaths,
    maxLowRiskLines: job.factory.sizeGateEnabled ? job.factory.maxLowRiskLines : null,
    lintCleanup: async () => {
      const run = await deps.runs.get(job.run.id);
      return run.isOk() && run.value !== null && lintCleanupSource(run.value) !== null;
    },
    approvalAdjustMaxLines: job.factory.approvalAdjustMaxLines,
    sizeIgnoredPaths: job.factory.sizeIgnoredPaths,
    autoMerge: job.factory.autoMerge,
    ...approvalDepsOf(deps, job, scope),
    storedProof: job.run.regressionProof,
    ...triageDepsOf(deps, job, scope, attempt.trace),
    ...reviewDepsOf(ctx, job, scope),
    enterStage: async (stage) => {
      const entered = await deps.runs.enterStage(job.run.id, stage);
      // Stopped or parked elsewhere: stop driving it.
      if (entered.isOk() && !entered.value) controller.abort();
    },
    lastThreadMessage: deps.lastThreadMessage ?? lastThreadMessage,
    lastAgentError,
    // Only an unchanged worktree (a read-only role's always is), with its branch.
    releaseRoleWorkspace: async (threadId) => {
      await deps.cleanupRoleThread?.(scope.userId, threadId);
    },
    removeUnchangedWorktrees: async () => {
      const run = await deps.runs.get(job.run.id);
      const ids = run.isOk() && run.value ? run.value.threadIds : job.run.threadIds;
      return (await deps.cleanupUnchanged?.(scope.userId, ids)) ?? [];
    },
    proof: proofFor(deps, scope),
    steps: deps.steps?.(scope.userId),
    integrateConfig: flow.integrate,
    flowIntegrates: flow.workflow.nodes.some((node) => node.integrate),
    record,
    signal: controller.signal,
    legacyReplay: attempt.legacyReplay,
  });
}
