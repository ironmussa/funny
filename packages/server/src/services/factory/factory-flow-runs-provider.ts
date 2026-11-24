/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 *
 * The server provider of one factory run's flow (`factory-flow-runs.ts`): the
 * run's scope, and what its steps read and write through the host (the issue,
 * the merge queue, stacking, follow-ups, the regression proof, stage slots).
 */

import type { ConcurrencyGate } from '@funny/pipelines';
import { err, ok, type Result } from 'neverthrow';

import { log } from '../../lib/logger.js';
import {
  createFactoryActionProvider,
  type FactoryContinuation,
  type FactoryProofDeps,
  type FactoryRunScope,
  NO_CHANGE_TRIAGE_LABEL,
} from './factory-action-provider.js';
import { createFactoryBatchesRepository } from './factory-batches.js';
import type { EarlyIntegration } from './factory-early-integration.js';
import {
  flowOf,
  type FactoryFlowRunsDeps,
  type FactoryRunJob,
  type FlowTrace,
} from './factory-flow-runs-model.js';
import {
  findLaunchedThread,
  followedUpSince,
  threadCompletedAt,
} from './factory-flow-runs-threads.js';
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
import { lastThreadMessage } from './factory-thread-waits.js';
import { busyPathsOf, type FactorySplitDeps } from './factory-triage.js';

/** What the flow runs keep per running run, that a run's provider writes. */
export interface RunsInFlight {
  /** Each running flow's early integration (D8), for the watcher to ask when the base moves. */
  earlyOf: Map<string, EarlyIntegration>;
  /** What orders a run in the merge group: whether it blocks other runs, and its size. */
  mergeOrder: Map<string, { blocker: boolean; lines?: number }>;
}

/** A blocker that ended in one of these will not merge: the runs stacked on it park (D10). */
const GONE_STATES: ReadonlySet<string> = new Set(['failed', 'stopped', 'no_change']);

/**
 * Per factory, one triage contract-and-paths check at a time (in this process,
 * like the watcher), as slot writes are serialized in `factory-runs.ts`: two
 * runs triaged together would otherwise each miss the other's paths.
 */
const pathChecks = (() => {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run<T>(factoryId: string, work: () => Promise<T>): Promise<T> {
      const result = (tails.get(factoryId) ?? Promise.resolve()).then(work);
      const tail = result.catch(() => undefined);
      tails.set(factoryId, tail);
      void tail.then(() => {
        if (tails.get(factoryId) === tail) tails.delete(factoryId);
      });
      return result;
    },
  };
})();

/** How many runs of a factory may be inside a stage at once, unless the flow or the factory says. */
const DEFAULT_STAGE_LIMIT = 20;

/** The concurrency group of a stage of one factory (`<node>:<factoryId>`). */
const stageGroup = (stage: string, factoryId: string) => `${stage}:${factoryId}`;

/** The default branch's GitHub Actions workflows, read as the leader's enabler; null if unreadable. */
const readWorkflows = (deps: FactoryFlowRunsDeps, leader: QueueMember) =>
  readWorkflowFiles(deps.github, {
    repo: leader.repo,
    ownerId: leader.userId,
    projectId: leader.projectId,
  });

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

/**
 * The merge queue for a run's `merge` step (openspec factory-integration
 * D2): absent where the GitHub side cannot build per-enabler providers.
 * A member that lands is recorded merged on its own run, and its threads'
 * worktrees are cleaned up as its own flow would.
 */
function queueFor(deps: FactoryFlowRunsDeps, signal: AbortSignal): FactoryQueuePort | undefined {
  const integrationFor = deps.github.pullRequests.integrationFor;
  if (!integrationFor) return undefined;
  const run = async (runId: string) => (await deps.runs.get(runId)).unwrapOr(null);
  return createFactoryQueuePort({
    batches: deps.batches ?? createFactoryBatchesRepository(),
    run,
    factory: getWatchedFactory,
    record: async (runId, input) => {
      const live = await deps.runs.updateInFlight(runId, input);
      if (!live.isOk() || !live.value || input.state !== 'merged' || !deps.cleanupMerged) return;
      const merged = await run(runId);
      const factory = merged ? await getWatchedFactory(merged.factoryId) : null;
      if (merged && factory) await deps.cleanupMerged(factory.userId, threadsOf(merged));
    },
    integrationFor: (owner) => integrationFor(owner),
    workflows: (leader) => readWorkflows(deps, leader),
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
  deps: FactoryFlowRunsDeps,
  runs: RunsInFlight,
  job: FactoryRunJob,
  scope: FactoryRunScope,
  signal: AbortSignal,
) {
  return {
    queue: queueFor(deps, signal),
    stackedOn: job.run.stackedOn,
    blockerState: () => blockerStateOf(deps, job.run.stackedOn),
    retarget: (base: string) => retargetRun(deps, job, scope, base),
    registerEarly: (early: EarlyIntegration) => runs.earlyOf.set(job.run.id, early),
    onChangeSize: (lines: number) => {
      const order = runs.mergeOrder.get(job.run.id) ?? { blocker: false };
      runs.mergeOrder.set(job.run.id, { ...order, lines });
    },
  };
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

/** The provider's reads and writes of the run's issue; they do nothing for a run without one. */
function issueDepsOf(deps: FactoryFlowRunsDeps, job: FactoryRunJob, scope: FactoryRunScope) {
  return {
    issueLabels: job.issue?.labels ?? [],
    issueUpdatedAt: async () => {
      if (scope.issueNumber === null) return null;
      const issue = await deps.github.getIssue(
        { repo: scope.repo, ownerId: scope.userId, projectId: scope.projectId },
        scope.issueNumber,
      );
      return issue.isOk() ? (issue.value.updatedAt ?? null) : null;
    },
    issueText: async () => {
      if (scope.issueNumber === null) return null;
      const text = await deps.github.issueText(
        { repo: scope.repo, ownerId: scope.userId, projectId: scope.projectId },
        scope.issueNumber,
      );
      return text.isOk() ? text.value : null;
    },
    releaseIssue: async () => {
      if (scope.issueNumber === null) return;
      const relabelled = await deps.github.relabelIssue(
        { repo: scope.repo, ownerId: scope.userId, projectId: scope.projectId },
        scope.issueNumber,
        { remove: job.factory.label || undefined, add: NO_CHANGE_TRIAGE_LABEL },
      );
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
  const open = deps.github.createIssue;
  const parent = scope.issueNumber;
  if (job.factory.tooBig !== 'split' || !open || parent === null) return undefined;
  const reader = { repo: scope.repo, ownerId: scope.userId, projectId: scope.projectId };
  return {
    openIssue: async (issue) => {
      const created = await open(reader, issue);
      return created.isOk() ? ok(created.value.number) : err(created.error.message);
    },
    queue: async (issueNumbers) => {
      if (issueNumbers.length === 0) return;
      const queued = await deps.runs.enqueue({
        factoryId: job.factory.id,
        issueNumbers,
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
/** What one run's provider is built from. */
interface RunProviderInput {
  job: FactoryRunJob;
  scope: FactoryRunScope;
  flow: FactoryFlow;
  projectDefaults: Awaited<ReturnType<typeof projectAgentDefaults>>;
  controller: AbortController;
  trace: FlowTrace;
  record: (input: UpdateRunInput) => Promise<void>;
  gate: ConcurrencyGate;
  waitThread: NonNullable<FactoryFlowRunsDeps['waitThread']>;
  legacyReplay: boolean;
}

/** The server provider of one run's flow. */
export function createRunProvider(
  deps: FactoryFlowRunsDeps,
  runs: RunsInFlight,
  input: RunProviderInput,
) {
  const { job, scope, flow, projectDefaults, controller, trace, record, gate } = input;
  const { waitThread, legacyReplay } = input;
  // What each agent step ran with, after the steps an earlier attempt recorded.
  const stepOptions = [...job.run.stepOptions];
  return createFactoryActionProvider({
    projectDefaults,
    // Read at every agent step: a change saved mid-run reaches the steps not started yet.
    stepOverrides: async () =>
      (await getWatchedFactory(job.factory.id))?.stepOverrides ?? job.factory.stepOverrides,
    recordStepOptions: async (entry) => {
      stepOptions.push(entry);
      await record({ stepOptions: [...stepOptions] });
    },
    scope,
    threadIds: job.run.threadIds,
    prUrl: job.run.prUrl,
    metrics: job.run.metrics,
    launchStartedAt: job.run.launchStartedAt,
    findLaunched: (titlePrefix, since) => findLaunchedThread(scope, titlePrefix, since),
    abandon: async (threadId) => deps.stopThreads?.(scope.userId, [threadId]),
    launch: (body) => deps.launch({ userId: scope.userId, body }),
    waitThread,
    continuation: continuationFor(deps, scope),
    github: deps.github,
    ...integrationDepsFor(deps, runs, job, scope, controller.signal),
    defaultBranch: () =>
      deps.github.defaultBranch({
        repo: scope.repo,
        ownerId: scope.userId,
        projectId: scope.projectId,
      }),
    ...issueDepsOf(deps, job, scope),
    split: splitDepsOf(deps, job, scope),
    sensitivePaths: job.factory.sensitivePaths,
    maxLowRiskLines: job.factory.maxLowRiskLines,
    sizeIgnoredPaths: job.factory.sizeIgnoredPaths,
    autoMerge: job.factory.autoMerge,
    // Read from the row: the member approves while the run waits.
    mergeApproved: async (sha) => {
      const run = await deps.runs.get(job.run.id);
      return run.isOk() && run.value?.mergeApproval?.sha === sha;
    },
    carryMergeApproval: async (from, to) => {
      const carried = await deps.runs.carryMergeApproval(job.run.id, from, to);
      if (carried.isErr()) {
        log.warn('Issue factory could not carry the merge approval to the merged base', {
          namespace: 'factory',
          runId: job.run.id,
          from,
          to,
          error: carried.error.message,
        });
      }
    },
    storedProof: job.run.regressionProof,
    triage: job.run.triage,
    findTriageThread: (titlePrefix, since) => findLaunchedThread(scope, titlePrefix, since, true),
    busyPaths: async () => {
      const others = await deps.runs.inFlight(job.factory.id);
      return others.isOk()
        ? busyPathsOf(others.value, job.run.id, job.run.stackedOn?.runId ?? null)
        : [];
    },
    holdForPaths: async (blockers) => {
      const held = await deps.runs.holdForPaths(job.run.id, blockers);
      if (held.isErr() || !held.value) return false;
      trace.held = true;
      return true;
    },
    exclusive: (work) => pathChecks.run(job.factory.id, work),
    reviews: job.run.reviews,
    admittedAt: job.run.admittedAt ?? job.run.startedAt,
    findReviewThread: (titlePrefix, since) => findLaunchedThread(scope, titlePrefix, since, true),
    reviewSlot: async (holder, signal) => {
      const grant = await gate.acquire({
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
    enterStage: async (stage) => {
      const entered = await deps.runs.enterStage(job.run.id, stage);
      // Stopped or parked elsewhere: stop driving it.
      if (entered.isOk() && !entered.value) controller.abort();
    },
    lastThreadMessage: deps.lastThreadMessage ?? lastThreadMessage,
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
    legacyReplay,
  });
}
