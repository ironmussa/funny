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
 * - `run_command`, `set_status`, `set_stage` and approvals are refused: there
 *   is nowhere on the server to run them (checks belong in the repository's CI).
 */

import {
  EMPTY_FACTORY_RUN_METRICS,
  reviewAllowsMerge,
  type FactoryAutoMerge,
  type FactoryReviewVerdict,
  type FactoryRisk,
  type FactoryRunMetrics,
} from '@funny/shared/contracts/factory';
import type {
  ActionProvider,
  ActionResult,
  ApprovalDecision,
  MergeOpts,
  RegressionProofOpts,
  SpawnAgentOpts,
} from '@funny/workflows/compiler';
import { err, ok, type Result } from 'neverthrow';
import { z } from 'zod';

import { log } from '../../lib/logger.js';
import { metric } from '../../lib/telemetry.js';
import type { StartedThread, StartThreadError } from '../runner-thread-launcher.js';
import { createFactoryCiActions } from './factory-ci-actions.js';
import type { FactoryGithubPort } from './factory-github.js';
import { createMergeLane } from './factory-merge-lane.js';
import {
  proofAllowsMerge,
  proofCheckOf,
  proofRecordOf,
  proveOnRunner,
  regressionTestRequired,
  type FactoryProofDeps,
  type ProofResultBody,
} from './factory-proof-runner.js';
import { prNumberOf, type FactoryPullRequestRef } from './factory-pull-requests.js';
import { createFactoryReviewer, reviewComment, reviewHeadline } from './factory-review.js';
import { classifyRisk } from './factory-risk.js';
import type { FactoryRunStage, RegressionProofRecord, UpdateRunInput } from './factory-runs.js';
import { checkTestWeakening, type TestWeakeningFinding } from './factory-test-weakening.js';
import type { KeptWorktree } from './factory-thread-requests.js';
import type { ThreadOutcome, WaitAfter } from './factory-thread-waits.js';

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

/** What a "no change" comment says about a checkout that was kept. */
function keptWorktreeLine(kept: KeptWorktree): string {
  const parts = [
    kept.dirtyFileCount > 0 ? `${kept.dirtyFileCount} uncommitted file(s)` : null,
    kept.unpushedCommitCount > 0 ? `${kept.unpushedCommitCount} unpushed commit(s)` : null,
  ].filter(Boolean);
  const what = parts.length > 0 ? parts.join(' and ') : 'work that could not be checked';
  return `The run's checkout was kept because it holds ${what}: \`${kept.worktreePath}\`.`;
}

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
  /** The change is high risk and the factory merges only low-risk changes. */
  highRisk: 'high risk',
} as const;

/** Why a run that ended without a commit or a pull request waits for a person. */
export const NO_CHANGE_REASON = 'no change';

/** The fixed first line of the issue comment a "no change" run posts. */
export const NO_CHANGE_LINE = 'The issue factory made no change for this issue. The agent said:';

/** Where the run's agent threads run: the enabler's runtime for the project. */
export type FactoryThreadMode = 'local' | 'worktree' | 'sandbox';

/** Everything a run's steps are bound to. */
export interface FactoryRunScope {
  runId: string;
  /** The factory's enabler: every thread and token is theirs. */
  userId: string;
  projectId: string;
  /** `owner/name`. */
  repo: string;
  mode: FactoryThreadMode;
  issueNumber: number;
  issueTitle: string;
  /** The branch the agent pushes and opens the pull request from. */
  branch: string;
  /** The issue's page (the reviewer reads the issue there). */
  issueUrl?: string;
}

export type { FactoryProofDeps } from './factory-proof-runner.js';
export { regressionTestRequired } from './factory-proof-runner.js';

export interface FactoryActionProviderDeps {
  scope: FactoryRunScope;
  /** Thread ids the run's agent steps already started, in order (a resumed run). */
  threadIds: string[];
  /** The run's pull request, when an earlier attempt found it. */
  prUrl: string | null;
  /** The run's integration counters so far (a resumed or retried run keeps counting). */
  metrics?: FactoryRunMetrics;
  /** The issue's labels (for require_test: labels). */
  issueLabels?: string[];
  /** The factory's own sensitive path globs (they make a change high risk). */
  sensitivePaths?: readonly string[];
  /** Which reviewed changes the factory merges by itself (default: only low-risk ones). */
  autoMerge?: FactoryAutoMerge;
  /** The review verdicts the run already has (a resumed run). */
  reviews?: readonly FactoryReviewVerdict[];
  /** When the run was admitted: review threads from before are not this run's. */
  admittedAt?: string;
  /** The newest review thread of this run by its title prefix, since `since`. */
  findReviewThread?(titlePrefix: string, since: string): Promise<string | null>;
  /** Take one of the factory's review slots (its `review` stage limit); resolves with its release. */
  reviewSlot?(holder: string, signal: AbortSignal): Promise<() => void>;
  /** The URLs of the factory's other open pull requests (the reviewer is told about them). */
  otherPullRequests?(): Promise<string[]>;
  /**
   * Move the run into its review or merge step: a compare-and-set on the
   * stored state (`enterStage` of the runs repository). Absent (tests): the
   * state is written like any other progress.
   */
  enterStage?(stage: FactoryRunStage): Promise<void>;
  /** Proof start/poll through the runner. */
  proof?: FactoryProofDeps;
  /** The implementing thread's last assistant message (the "no change" explanation). */
  lastThreadMessage?: (threadId: string) => Promise<string | null>;
  /**
   * Remove the run's worktrees on the enabler's runner (a "no change" run keeps
   * no checkout), except the ones holding work that exists nowhere else
   * (uncommitted files, unpushed commits), which are returned.
   */
  removeUnchangedWorktrees?: () => Promise<KeptWorktree[]>;
  /**
   * Set when the run was interrupted while starting its next agent thread:
   * that step first looks for the thread it may have started.
   */
  launchStartedAt: string | null;
  /**
   * A factory thread of the enabler whose title starts with `titlePrefix`
   * (`[Factory] #N `, stable even if the issue is renamed) created since
   * `since`, if any.
   */
  findLaunched(titlePrefix: string, since: string): Promise<string | null>;
  /** Stop a thread this run started after it was stopped (a launch racing the stop). */
  abandon?(threadId: string): Promise<void>;
  /** Start a thread on the enabler's runner (`startThreadOnRunner` for the enabler). */
  launch(body: Record<string, unknown>): Promise<Result<StartedThread, StartThreadError>>;
  /** Resolves with the thread's terminal status (or why it never will reach one). */
  waitThread(threadId: string, signal: AbortSignal, after?: WaitAfter): Promise<ThreadOutcome>;
  /** Continue the first thread for later agent steps; without it each step starts a thread. */
  continuation?: FactoryContinuation;
  github: Pick<
    FactoryGithubPort,
    'findPullRequest' | 'pullRequests' | 'branchAhead' | 'commentOnIssue'
  >;
  /**
   * The repository's default branch. A worktree run starts from the remote's
   * copy of it, so the pull request holds the agent's commits only: not the
   * branch the enabler's checkout happens to be on, nor their unpushed commits.
   * Absent (tests): the runner picks the base.
   */
  defaultBranch?: () => PromiseLike<Result<string, { message: string }>>;
  /** Write the run's progress; ignored once the run is terminal (e.g. stopped). */
  record(input: UpdateRunInput): Promise<void>;
  /**
   * Replay agent steps by call order from `threadIds` (the run has no journal
   * rows). Default true; false when the engine's journal resumes the run.
   */
  legacyReplay?: boolean;
  signal: AbortSignal;
}

/** Following up on a run's thread, as the enabler. */
export interface FactoryContinuation {
  followUp(threadId: string, content: string): Promise<Result<void, string>>;
  /** The thread's `completedAt` now (before a follow-up runs it again). */
  completedAt(threadId: string): Promise<string | null>;
  /** Whether a member/user message reached the thread since `since` (an interrupted follow-up). */
  followedUpSince(threadId: string, since: string): Promise<boolean>;
  /**
   * Follow up on a thread that is not on the run's branch (a reviewer's):
   * `followUp` without the branch guard. Absent: such a thread cannot be asked again.
   */
  followUpOffBranch?(threadId: string, content: string): Promise<Result<void, string>>;
}

/** The thread an agent step waits on; `after` when a follow-up runs it again. */
interface StepThread {
  threadId: string;
  after?: WaitAfter;
  /** A step recorded before a resume, retry or take-over. */
  replayed?: boolean;
}

/**
 * What an agent step records in the journal about its work in progress, so
 * a resumed execution adopts it instead of starting it again.
 */
const STEP_CHECKPOINT = z.discriminatedUnion('phase', [
  /** A launch was being made since `since`; its thread may exist. */
  z.object({ phase: z.literal('launching'), since: z.string() }),
  /** A follow-up was being sent to `threadId` since `since`. */
  z.object({
    phase: z.literal('following-up'),
    threadId: z.string(),
    since: z.string(),
    before: z.string().nullable(),
  }),
  /** The step's thread, and what its wait waits for when a follow-up runs it again. */
  z.object({
    phase: z.literal('thread'),
    threadId: z.string(),
    after: z.object({ completedAt: z.string().nullable(), sentAt: z.string() }).optional(),
  }),
]);
type StepCheckpoint = z.infer<typeof STEP_CHECKPOINT>;

/** Record a checkpoint of the step in progress (a no-op outside a journaled run). */
type Checkpoint = (state: StepCheckpoint) => Promise<void>;

const noCheckpoint: Checkpoint = async () => {};

/** Allowance for the runner's clock when comparing its timestamps with the server's. */
const CLOCK_SLACK_MS = 60 * 1000;

const refused = (step: string, why: string): ActionResult => ({
  ok: false,
  error: `${step} is not available in a factory flow: ${why}`,
});

function prompted(opts: SpawnAgentOpts): string {
  return opts.context
    ? `${opts.prompt}\n\nContext from previous step:\n${opts.context}`
    : opts.prompt;
}

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

/** What the server found in one commit of the run's pull request. */
interface ClassifiedHead {
  sha: string;
  findings: TestWeakeningFinding[];
  risk: FactoryRisk;
}

/** A proof the merge gate holds: its record, and what publishing it needs. */
interface HeldProof {
  record: RegressionProofRecord;
  /** Whether this issue needs a regression test (decides the check's conclusion). */
  testRequired: boolean;
  /** Its verdict allows a merge. */
  ok: boolean;
  /** Its check is on GitHub. */
  checkPublished: boolean;
}

const PROOF_NOT_CONFIGURED: ActionResult = {
  ok: false,
  error:
    'Regression proof not configured: the flow has no regression_proof rules, so the factory does not merge.',
};

/** The counters after a reviewer event: a verdict counts as a review, a failing one also as a fail. */
export function reviewCounted(metrics: FactoryRunMetrics, event: string): FactoryRunMetrics {
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

function outcomeResult(threadId: string, outcome: ThreadOutcome): ActionResult {
  if (outcome.status === 'completed') {
    return { ok: true, output: outcome.output, metadata: { threadId } };
  }
  return {
    ok: false,
    error: outcome.reason ?? `The agent thread ended ${outcome.status}.`,
    metadata: { threadId, status: outcome.status },
  };
}

export function createFactoryActionProvider(deps: FactoryActionProviderDeps): ActionProvider {
  const { scope } = deps;
  const threadIds = [...deps.threadIds];
  let agentSteps = 0;
  let prUrl = deps.prUrl;
  let pendingLaunch = deps.launchStartedAt;
  let metrics: FactoryRunMetrics = { ...EMPTY_FACTORY_RUN_METRICS, ...deps.metrics };

  /** Add to the run's counters and store them with the run. */
  async function count(next: FactoryRunMetrics | null, attributes: Record<string, string>) {
    if (!next) return;
    metrics = next;
    metric('factory.integration_event', 1, {
      type: 'sum',
      attributes: { ...attributes, repo: scope.repo },
    });
    await deps.record({ metrics });
  }
  const titlePrefix = `[Factory] #${scope.issueNumber} `;
  const title = `${titlePrefix}${scope.issueTitle}`.slice(0, 200);

  const pullRequest = (): FactoryPullRequestRef | null => {
    const number = prNumberOf(prUrl);
    if (number === null) return null;
    return {
      repo: scope.repo,
      number,
      branch: scope.branch,
      userId: scope.userId,
      projectId: scope.projectId,
    };
  };

  const ci = createFactoryCiActions({
    prs: deps.github.pullRequests,
    pullRequest,
    signal: deps.signal,
    markMerged: () => deps.record({ state: 'merged', currentStep: null }),
  });

  /** Record the step's thread; the launch marker is cleared in the same write. */
  async function recordThread(threadId: string): Promise<string> {
    threadIds.push(threadId);
    // A fix after the pull request is open is a `fixing` step, not new work.
    await deps.record({
      state: prUrl ? 'fixing' : 'working',
      threadIds: [...threadIds],
      launchStartedAt: null,
    });
    // Stopped while the launch was in flight: the stop missed this thread.
    if (deps.signal.aborted) await deps.abandon?.(threadId);
    return threadId;
  }

  /** The thread an interrupted launch of this step started, if it got that far. */
  async function adoptInterrupted(step: number): Promise<string | null> {
    const since = pendingLaunch;
    pendingLaunch = null;
    if (!since || step !== threadIds.length) return null;
    const found = await deps.findLaunched(titlePrefix, since);
    return found && !threadIds.includes(found) ? found : null;
  }

  /** Continue the run's first thread with this step's prompt (a later agent step). */
  async function followUp(
    continuation: FactoryContinuation,
    first: string,
    opts: SpawnAgentOpts,
    checkpoint: Checkpoint = noCheckpoint,
  ): Promise<StepThread | ActionResult> {
    const since = pendingLaunch;
    pendingLaunch = null;
    if (since && (await continuation.followedUpSince(first, since))) {
      // Sent before an interruption: wait for that run, do not send it twice.
      return {
        threadId: await recordThread(first),
        after: await interruptedAfter(continuation, first, since),
      };
    }
    const before = await continuation.completedAt(first);
    const sentAt = new Date().toISOString();
    await checkpoint({ phase: 'following-up', threadId: first, since: sentAt, before });
    await deps.record({ launchStartedAt: sentAt });
    const sent = await continuation.followUp(first, prompted(opts));
    if (sent.isErr()) {
      await deps.record({ launchStartedAt: null });
      return { ok: false, error: `The agent could not continue: ${sent.error}` };
    }
    // A follow-up once the pull request is open is a fix (CI or conflict), not new work.
    if (prUrl)
      await count({ ...metrics, agentFixes: metrics.agentFixes + 1 }, { event: 'agent_fix' });
    const after = { completedAt: before, sentAt };
    await checkpoint({ phase: 'thread', threadId: first, after });
    return { threadId: await recordThread(first), after };
  }

  /**
   * What an adopted (interrupted) follow-up waits for: when the thread last
   * finished before the follow-up was sent, the follow-up's own run has not
   * finished yet, so wait for `completedAt` to change.
   */
  async function interruptedAfter(
    continuation: FactoryContinuation,
    threadId: string,
    since: string,
  ): Promise<WaitAfter | undefined> {
    const current = await continuation.completedAt(threadId);
    const finishedBefore =
      current !== null && Date.parse(current) < Date.parse(since) - CLOCK_SLACK_MS;
    return finishedBefore ? { completedAt: current, sentAt: since } : undefined;
  }

  /**
   * Where a worktree run's branch starts: the remote's default branch. Not
   * knowing it fails the step, since the runner would then start from whatever
   * the enabler's checkout has (run #227 opened a pull request with 11 commits
   * that were not the agent's).
   */
  async function worktreeBase(): Promise<
    { baseBranch?: string; baseFromRemote?: boolean } | { error: string }
  > {
    if (scope.mode !== 'worktree' || !deps.defaultBranch) return {};
    const branch = await deps.defaultBranch();
    if (branch.isErr()) {
      return {
        error: `The agent could not start: the repository's default branch could not be read (${branch.error.message}).`,
      };
    }
    return { baseBranch: branch.value, baseFromRemote: true };
  }

  /** Start a new thread for this step, marked first so a crash in between is adopted. */
  async function launchNew(
    opts: SpawnAgentOpts,
    checkpoint: Checkpoint = noCheckpoint,
  ): Promise<StepThread | ActionResult> {
    const base = await worktreeBase();
    if ('error' in base) return { ok: false, error: base.error };
    const since = new Date().toISOString();
    await checkpoint({ phase: 'launching', since });
    await deps.record({ launchStartedAt: since });
    const launched = await deps.launch({
      projectId: scope.projectId,
      title,
      mode: scope.mode,
      ...base,
      // A worktree thread is created on the run's branch, so the thread, its
      // worktree and the pull request share one branch.
      branch: scope.branch,
      source: 'factory',
      prompt: prompted(opts),
      model: opts.model ?? undefined,
    });
    const threadId = launched.isOk() ? launched.value.threadId : undefined;
    if (threadId) {
      await checkpoint({ phase: 'thread', threadId });
      return { threadId: await recordThread(threadId) };
    }
    await deps.record({ launchStartedAt: null });
    return {
      ok: false,
      error: launched.isErr()
        ? `The agent could not start: ${launched.error.message}`
        : 'The agent could not start: the runner returned no thread.',
    };
  }

  /** Record `threadId` in the display list unless a resumed step already did. */
  const rememberThread = async (threadId: string) =>
    threadIds.includes(threadId) ? threadId : recordThread(threadId);

  /**
   * The work a resumed journaled step checkpointed, adopted: its thread, or
   * the thread its interrupted launch started, or its follow-up when it was
   * sent. Undefined when there is nothing to adopt and the step starts over.
   */
  async function adoptCheckpoint(
    state: StepCheckpoint,
    checkpoint: Checkpoint,
  ): Promise<StepThread | undefined> {
    if (state.phase === 'thread') {
      return { threadId: await rememberThread(state.threadId), after: state.after };
    }
    if (state.phase === 'launching') {
      const found = await deps.findLaunched(titlePrefix, state.since);
      if (!found) return undefined;
      await checkpoint({ phase: 'thread', threadId: found });
      return { threadId: await rememberThread(found) };
    }
    const continuation = deps.continuation;
    if (!continuation || !(await continuation.followedUpSince(state.threadId, state.since))) {
      return undefined;
    }
    // Sent before the interruption: wait for that run, do not send it twice.
    const after = { completedAt: state.before, sentAt: state.since };
    await checkpoint({ phase: 'thread', threadId: state.threadId, after });
    return { threadId: await rememberThread(state.threadId), after };
  }

  /** A journaled step's thread: adopted from its checkpoint, a follow-up, or new. */
  async function journaledThreadFor(opts: SpawnAgentOpts): Promise<StepThread | ActionResult> {
    const execution = opts.execution;
    const checkpoint: Checkpoint = execution
      ? (state) => execution.checkpoint(state)
      : noCheckpoint;
    // The journal resumes the run; the launch marker belongs to the numbering path.
    pendingLaunch = null;
    const saved = STEP_CHECKPOINT.safeParse(execution?.resume?.recorded.data);
    const adopted = saved.success ? await adoptCheckpoint(saved.data, checkpoint) : undefined;
    if (adopted) return adopted;
    const first = threadIds[0];
    if (first && deps.continuation) return followUp(deps.continuation, first, opts, checkpoint);
    return launchNew(opts, checkpoint);
  }

  /** The thread of the current agent step: recorded, continued, adopted, or new. */
  async function threadFor(opts: SpawnAgentOpts, step: number): Promise<StepThread | ActionResult> {
    const recorded = threadIds[step];
    if (recorded) return { threadId: recorded, replayed: true };
    const first = threadIds[0];
    if (step > 0 && first && deps.continuation) return followUp(deps.continuation, first, opts);
    const adopted = await adoptInterrupted(step);
    return adopted ? { threadId: await recordThread(adopted) } : launchNew(opts);
  }

  /**
   * The last proof this execution ran: its record (which commit), whether its
   * verdict allows a merge, and whether its check is on GitHub (auto-merge
   * needs it).
   */
  let lastProof: HeldProof | null = null;

  /** Run the proof on the runner, record and publish it, and map its verdict to the step's result. */
  async function runRegressionProof(opts: RegressionProofOpts): Promise<ActionResult> {
    if (!deps.proof) return proofUnavailable('the proof service is not configured.');
    const threadId = threadIds[0];
    if (!threadId) return proofUnavailable('no implementing thread.');
    const testRequired = regressionTestRequired(opts, deps.issueLabels ?? []);
    const run = await proveOnRunner(deps.proof, threadId, opts, deps.signal);
    if (run.kind === 'unavailable') return proofUnavailable(run.why);
    return proofVerdict(run.result, testRequired);
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
    const meta: Record<string, unknown> = { ...proofRecord };
    // What the merge gate holds: only a proof that names its commit.
    if (proofRecord.headSha) {
      lastProof = {
        record: proofRecord,
        testRequired,
        ok: proofAllowsMerge(result, testRequired),
        checkPublished,
      };
    }

    if (proofAllowsMerge(result, testRequired)) {
      const event =
        result.verdict === 'pass' ? 'regression_proof_pass' : 'regression_proof_skipped';
      await count(metrics, { event });
      return { ok: true, output: result.verdict, metadata: meta };
    }
    await count(metrics, { event: 'regression_proof_fail' });
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
   * What the server found in the last classified commit of the pull request:
   * its weakened tests and its risk class (change factory-agent-roles, D6).
   */
  let classified: ClassifiedHead | null = null;

  /**
   * Check the pull request's head commit for weakened tests and class its risk,
   * once per commit, and store the class on the run. A change that cannot be
   * read is high risk: what was not read was not checked.
   */
  async function classifyHead(): Promise<ClassifiedHead | null> {
    const pr = pullRequest();
    if (!pr) return null;
    const head = await deps.github.pullRequests.pullHead(pr);
    if (head.isErr()) return null;
    const sha = head.value.sha;
    if (classified?.sha === sha) return classified;
    const files = await deps.github.pullRequests.changedFiles(pr);
    const findings = files.isOk() ? checkTestWeakening(files.value) : [];
    const risk: FactoryRisk = files.isOk()
      ? classifyRisk({
          headSha: sha,
          change: files.value,
          findings,
          sensitivePaths: deps.sensitivePaths,
        })
      : {
          headSha: sha,
          level: 'high',
          reasons: [`the change could not be read: ${files.error.message}`],
        };
    classified = { sha, findings, risk };
    await deps.record({ risk });
    metric('factory.integration_event', 1, {
      type: 'sum',
      attributes: { event: `risk_${risk.level}`, repo: scope.repo },
    });
    return classified;
  }

  /**
   * Put a verdict on the run's pull request. Best effort: a failure is logged
   * and counted, and the verdict the run stored still decides the merge.
   */
  async function publishVerdict(verdict: FactoryReviewVerdict) {
    const pr = pullRequest();
    if (!pr) return { comment: false, status: false };
    const published = await deps.github.pullRequests.publishReview(pr, {
      sha: verdict.sha,
      allowsMerge: reviewAllowsMerge(verdict),
      body: reviewComment(verdict),
      description: reviewHeadline(verdict),
    });
    if (published.isOk()) return { comment: true, status: published.value.status };
    log.warn('Issue factory could not publish the review verdict', {
      namespace: 'factory',
      runId: scope.runId,
      sha: verdict.sha,
      error: published.error.message,
    });
    metric('factory.integration_event', 1, {
      type: 'sum',
      attributes: { event: 'review_unpublished', repo: scope.repo },
    });
    return { comment: false, status: false };
  }

  const enterStage = async (stage: FactoryRunStage) =>
    deps.enterStage
      ? deps.enterStage(stage)
      : deps.record({ state: stage === 'review' ? 'reviewing' : 'merging' });

  const offBranch = deps.continuation?.followUpOffBranch;
  const reviewer = createFactoryReviewer({
    scope,
    issueUrl: scope.issueUrl ?? null,
    reviews: deps.reviews ?? [],
    since: deps.admittedAt ?? new Date(0).toISOString(),
    signal: deps.signal,
    pullRequest,
    prUrl: () => prUrl,
    headSha: async () => {
      const pr = pullRequest();
      if (!pr) return err('The run has no pull request yet.');
      const head = await deps.github.pullRequests.pullHead(pr);
      return head.isOk() ? ok(head.value.sha) : err(head.error.message);
    },
    classify: classifyHead,
    launch: deps.launch,
    findLaunched: async (prefix, since) => (await deps.findReviewThread?.(prefix, since)) ?? null,
    waitThread: deps.waitThread,
    finalMessage: async (threadId) => (await deps.lastThreadMessage?.(threadId)) ?? null,
    followUp:
      offBranch && deps.continuation
        ? { send: offBranch, completedAt: deps.continuation.completedAt }
        : undefined,
    abandon: deps.abandon,
    worktreeBase,
    otherPullRequests: deps.otherPullRequests,
    acquireSlot: deps.reviewSlot,
    publish: publishVerdict,
    record: deps.record,
    enterReview: () => enterStage('review'),
    count: (event) => count(reviewCounted(metrics, event), { event }),
  });

  /** The enabler reads the repository: the App token capped by their access. */
  const reader = { repo: scope.repo, ownerId: scope.userId, projectId: scope.projectId };

  /**
   * The agent pushed no commit and opened no pull request: say so on the issue
   * with its explanation, remove the run's checkout, and leave the run for a
   * person (`no change`). Not ok, so the flow stops here.
   *
   * A checkout with uncommitted files or unpushed commits is kept and named in
   * the comment: the agent may have stopped before committing (issue #229 lost
   * 85 edited files this way).
   */
  async function noChange(): Promise<ActionResult> {
    const threadId = threadIds[0];
    const explanation = threadId ? await deps.lastThreadMessage?.(threadId) : null;
    const kept = (await deps.removeUnchangedWorktrees?.()) ?? [];
    const body = [NO_CHANGE_LINE, explanation, ...kept.map(keptWorktreeLine)]
      .filter(Boolean)
      .join('\n\n');
    const commented = await deps.github.commentOnIssue(reader, scope.issueNumber, body);
    if (commented.isErr()) {
      log.warn('Issue factory could not comment a no-change outcome on the issue', {
        namespace: 'factory',
        runId: scope.runId,
        issue: scope.issueNumber,
        error: commented.error.message,
      });
    }
    await deps.record({ state: 'waiting_human', failureReason: NO_CHANGE_REASON });
    await count(metrics, { event: 'no_change' });
    return {
      ok: false,
      error: `No change: the agent made no commit on ${scope.branch} and opened no pull request.`,
      metadata: { outcome: 'no_change' },
    };
  }

  /**
   * The passing proof of `sha`: the last one when it is of that commit and
   * passed, else a proof run now. Otherwise the result the merge step ends with.
   */
  async function proofOfHead(
    config: RegressionProofOpts,
    sha: string,
  ): Promise<{ held: HeldProof } | { refused: ActionResult }> {
    if (lastProof?.record.headSha !== sha || !lastProof.ok) {
      const proved = await runRegressionProof(config);
      if (!proved.ok) return { refused: proved };
    }
    if (lastProof?.record.headSha !== sha) {
      return {
        refused: {
          ok: false,
          error: `Regression proof unavailable: the pull request head ${sha} is not the proved commit ${lastProof?.record.headSha ?? '(none)'}.`,
        },
      };
    }
    return { held: lastProof };
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

  /** Leave the run for a person instead of merging, with why. Not ok, so the flow stops here. */
  async function holdMerge(reason: string, error: string): Promise<ActionResult> {
    await deps.record({ state: 'waiting_human', failureReason: reason });
    // Why runs stop being unattended: the reason is the event, per repository.
    await count(
      { ...metrics, mergeHolds: metrics.mergeHolds + 1 },
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

  /** The `wait_ci` options of the flow's last look, reused when the merge waits on a new head. */
  let lastWaitCi: Parameters<typeof ci.waitCi>[0] = {};

  const lane = createMergeLane({
    prs: deps.github.pullRequests,
    pullRequest,
    branch: scope.branch,
    signal: deps.signal,
    waitChecks: async () => {
      const result = await ci.waitCi(lastWaitCi);
      const verdict = result.metadata?.verdict;
      await count(countCiResult(metrics, result), { event: 'ci_round', verdict: String(verdict) });
      return result;
    },
  });

  /**
   * What `merge` checks itself on entry, whatever path led to it (a repository
   * flow draws its own): the head commit has a verdict of the flow's own
   * `review` step that allows a merge (unless `require_review: false`), and
   * its risk class is one the factory merges by itself. A check, status or
   * approval an external reviewer left on the pull request is not a verdict.
   * Null when the merge may go on.
   */
  async function mergeHeld(opts: MergeOpts, sha: string): Promise<ActionResult | null> {
    const rewritten = await historyRewritten(sha);
    if (rewritten) return rewritten;
    if (opts.requireReview !== false) {
      const verdict = reviewer.verdicts().find((review) => review.sha === sha);
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
    const change = await classifyHead();
    if (change?.sha === sha && change.risk.level === 'high' && deps.autoMerge !== 'all') {
      return holdMerge(
        MERGE_HOLD_REASONS.highRisk,
        `Not merged: the change is high risk (${change.risk.reasons.join('; ')}). This factory merges only low-risk changes by itself.`,
      );
    }
    return null;
  }

  /**
   * The merge gate: merge only a pull request head that passed the flow's
   * review and has a passing proof of that exact commit, pinned to it. Runs
   * the flow's proof when none is held.
   */
  async function provedMerge(opts: MergeOpts): Promise<ActionResult> {
    await enterStage('merge');
    const pr = pullRequest();
    if (!pr) return ci.merge(opts);
    const head = await deps.github.pullRequests.pullHead(pr);
    if (head.isErr()) {
      return { ok: false, error: head.error.message, metadata: { kind: head.error.kind } };
    }
    const held = await mergeHeld(opts, head.value.sha);
    if (held) return held;

    // Green on an old base proves nothing about the base as it is now.
    const current = await lane.bringUpToDate();
    if (current.kind === 'failed') return { ok: false, error: current.error };
    if (current.kind === 'sent-back') {
      await count(
        { ...metrics, mergeSentBack: metrics.mergeSentBack + 1 },
        { event: `merge_sent_back_${current.why}` },
      );
      return {
        ok: true,
        output: 'sent_back',
        metadata: { outcome: 'sent_back', why: current.why, feedback: current.feedback },
      };
    }
    for (const step of current.carried) await reviewer.carry(step.from, step.to);
    const sha = current.sha;
    if (sha !== head.value.sha) {
      const heldNow = await mergeHeld(opts, sha);
      if (heldNow) return heldNow;
    }
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

  return {
    async spawnAgent(opts) {
      const index = agentSteps++;
      const step =
        (deps.legacyReplay ?? true) ? await threadFor(opts, index) : await journaledThreadFor(opts);
      if (!('threadId' in step)) return step;
      // A replayed step that a LATER recorded step continued on the same thread
      // finished before that one started: waiting on the thread now would read
      // the later step's run instead of this one.
      if (step.replayed && threadIds.slice(index + 1).includes(step.threadId)) {
        return { ok: true, output: '', metadata: { threadId: step.threadId, replayed: true } };
      }
      return outcomeResult(
        step.threadId,
        await deps.waitThread(step.threadId, deps.signal, step.after),
      );
    },

    async gitCommit() {
      return { ok: true, output: 'The agent commits on the runner.' };
    },

    async gitPush() {
      return { ok: true, output: 'The agent pushes on the runner.' };
    },

    async createPr() {
      const found = await deps.github.findPullRequest(reader, scope.branch);
      if (found.isErr()) return { ok: false, error: found.error.message };
      if (!found.value) {
        const ahead = await deps.github.branchAhead(reader, scope.branch);
        if (ahead.isOk() && !ahead.value) return noChange();
        return {
          ok: false,
          error: `No open pull request from the branch ${scope.branch}: the agent did not open one.`,
        };
      }
      prUrl = found.value.url;
      await deps.record({ state: 'pr_open', prUrl });
      return { ok: true, output: prUrl, metadata: { number: found.value.number } };
    },

    async waitCi(opts) {
      lastWaitCi = {
        timeoutMs: opts.timeoutMs,
        intervalMs: opts.intervalMs,
        requiredChecks: opts.requiredChecks,
      };
      await deps.record({ state: 'waiting_ci' });
      // When the commit's checks start: the report is ready before the review,
      // and the reviewer starts on this commit without waiting for green
      // (D7). A review of an older commit is stopped and its result dropped.
      const head = await classifyHead();
      if (head && opts.earlyReview) await reviewer.startEarly(head.sha, opts.earlyReview);
      const result = await ci.waitCi(opts);
      const verdict = result.metadata?.verdict;
      await count(countCiResult(metrics, result), { event: 'ci_round', verdict: String(verdict) });
      return result;
    },

    merge: (opts) => provedMerge(opts),

    regressionProof: (opts) => runRegressionProof(opts),

    review: (opts) => reviewer.review(opts),

    async notify(opts) {
      log.info('Issue factory flow notice', {
        namespace: 'factory',
        runId: scope.runId,
        level: opts.level ?? 'info',
        message: opts.message,
      });
      return { ok: true };
    },

    async runCommand() {
      return refused('run_command', 'the server has no checkout; run checks in CI (wait_ci).');
    },

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
