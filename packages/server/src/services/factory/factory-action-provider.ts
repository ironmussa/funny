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
  contractOf,
  EMPTY_FACTORY_RUN_METRICS,
  reviewAllowsMerge,
  type FactoryApprovalMove,
  type FactoryAutoMerge,
  type FactoryMergeApproval,
  type FactoryReviewVerdict,
  type FactoryRisk,
  type FactoryRunMetrics,
  type FactoryStackedOn,
  type FactoryTriage,
} from '@funny/shared/contracts/factory';
import { EMPTY_INTEGRATE_CONFIG, type IntegrateConfig } from '@funny/workflows';
import type {
  ActionProvider,
  ActionResult,
  ApprovalDecision,
  MergeOpts,
  RegressionProofOpts,
  RunCommandOpts,
  SpawnAgentOpts,
} from '@funny/workflows/compiler';
import { err, errAsync, ok, type Result } from 'neverthrow';
import { z } from 'zod';

import { log } from '../../lib/logger.js';
import { metric } from '../../lib/telemetry.js';
import type { StartedThread, StartThreadError } from '../runner-thread-launcher.js';
import {
  approvalCovers,
  approvalMoveComment,
  type ApprovalMove,
} from './factory-approval-carry.js';
import { createFactoryCiActions } from './factory-ci-actions.js';
import {
  createEarlyIntegration,
  createWorkspaceLock,
  type EarlyIntegration,
} from './factory-early-integration.js';
import type { FactoryGithubPort } from './factory-github.js';
import { createFactoryIntegrate } from './factory-integrate.js';
import type { FactoryIssueText } from './factory-issue-text.js';
import { mergeAsBatch } from './factory-merge-batch.js';
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
import { withBatchStats, type FactoryQueuePort } from './factory-queue-port.js';
import { createFactoryReviewer, reviewComment, reviewHeadline } from './factory-review.js';
import { classifyRisk, UNREADABLE_RISK_KEY } from './factory-risk.js';
import {
  HIGH_RISK_HOLD,
  factoryRunLabel,
  type FactoryRunStage,
  type RegressionProofRecord,
  type UpdateRunInput,
} from './factory-runs.js';
import { createStacking, type BlockerState } from './factory-stacking.js';
import {
  resolveStepOptions,
  type ProjectAgentDefaults,
  type ResolvedStepOptions,
  type StepOverrides,
} from './factory-step-options.js';
import {
  changeDeltaOnRunner,
  runStepOnRunner,
  type ChangeDelta,
  type FactoryStepDeps,
} from './factory-step-runner.js';
import { checkTestWeakening, type TestWeakeningFinding } from './factory-test-weakening.js';
import type { KeptWorktree } from './factory-thread-requests.js';
import type { ThreadOutcome, WaitAfter } from './factory-thread-waits.js';
import { createFactoryTriage, type FactorySplitDeps } from './factory-triage.js';

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

/**
 * Why a run without a commit or a pull request waits for a person: its checkout
 * held unsaved work, so the agent may not have meant "nothing to change".
 */
export const NO_CHANGE_REASON = 'no change';

/** The label an issue gets when its run ended with no change: a person decides what is next. */
export const NO_CHANGE_TRIAGE_LABEL = 'needs-triage';

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
  /** The run's issue, or null for a run without one (change flow-triggers). */
  issueNumber: number | null;
  /** The issue's title, or the trigger's name for a run without an issue. */
  issueTitle: string;
  /** The branch the agent pushes and opens the pull request from. */
  branch: string;
  /** The issue's page (the reviewer reads the issue there). */
  issueUrl?: string;
}

/** The scope of a run that has an issue: what the steps judging a change against it need. */
export type IssueRunScope = FactoryRunScope & { issueNumber: number };

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
  /** The factory's size limit for a low-risk change. */
  maxLowRiskLines?: number;
  /** The factory's globs left out of a change's size. */
  sizeIgnoredPaths?: readonly string[];
  /** Which reviewed changes the factory merges by itself (default: only low-risk ones). */
  autoMerge?: FactoryAutoMerge;
  /**
   * Whether a member approved merging `sha` although it is high risk, read
   * when the merge gate runs (the approval is written while the run waits).
   */
  mergeApproved?: (sha: string) => Promise<boolean>;
  /** The member's merge approval the run has, of whatever commit; read like `mergeApproved`. */
  mergeApproval?: () => Promise<FactoryMergeApproval | null>;
  /**
   * Move a member's merge approval of `from` to `to`: a merge of `from` with
   * the base branch that settled nothing (as the review and the proof move),
   * or, with `move`, a commit whose change `approvalCovers` found covered.
   */
  carryMergeApproval?: (
    from: string,
    to: string,
    move?: Pick<FactoryApprovalMove, 'kind' | 'lines' | 'files'>,
  ) => Promise<void>;
  /** The largest adjustment an approval follows, in lines (default 0: only the same change). */
  approvalAdjustMaxLines?: number;
  /** An approval moved to another commit: record it for the member who approved. */
  onApprovalMoved?: (move: ApprovalMove) => Promise<void>;
  /** The review verdicts the run already has (a resumed run). */
  reviews?: readonly FactoryReviewVerdict[];
  /** The regression proof the run already has (a resumed run). */
  storedProof?: RegressionProofRecord | null;
  /** What the run already stores of its triage (a resumed run, or one back from a path hold). */
  triage?: FactoryTriage | null;
  /** The newest triage thread of this run by its title prefix, since `since`. */
  findTriageThread?(titlePrefix: string, since: string): Promise<string | null>;
  /** The likely paths of the factory's other runs in progress, by issue. */
  busyPaths?(): Promise<Array<{ issue: number; paths: string[] }>>;
  /** When the run's issue last changed, by GitHub's clock; null when unreadable. */
  issueUpdatedAt?(): Promise<string | null>;
  /** The run's issue as text, for the read-only roles (they have no network); null when unreadable. */
  issueText?(): Promise<FactoryIssueText | null>;
  /** Leave the slot and wait in the queue behind `blockers` (from `triaging` only). */
  holdForPaths?(blockers: number[]): Promise<boolean>;
  /** Open a too-large issue's parts as issues (the factory's `split` setting); absent: comment the split. */
  split?: FactorySplitDeps;
  /** Run `work` alone among the factory's runs (triage's contract and path check). */
  exclusive?<T>(work: () => Promise<T>): Promise<T>;
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
  /** Factory steps (a flow's command, integrate) start/poll through the runner. */
  steps?: FactoryStepDeps;
  /**
   * The merge queue (openspec factory-integration D2): when `merge` leads a
   * batch of the merge group, the members are tested and merged with it.
   * Absent: every merge takes the serial path.
   */
  queue?: FactoryQueuePort;
  /** The run this one is stacked on (openspec factory-integration D10), or null. */
  stackedOn?: FactoryStackedOn | null;
  /** Where the blocker of a stacked run stands. */
  blockerState?: () => Promise<BlockerState>;
  /** Point the run's pull request at another base branch (a stacked run, once its blocker landed). */
  retarget?: (base: string) => Promise<Result<void, string>>;
  /** Receives the run's early integration (D8), for the watcher to ask when the base moves. */
  registerEarly?(early: EarlyIntegration): void;
  /** The pull request's size in changed lines, once read: the merge queue's order (D11). */
  onChangeSize?(lines: number): void;
  /** `.funny/integrate.yaml` as the flow was loaded with it: what `integrate` regenerates and checks. */
  integrateConfig?: IntegrateConfig;
  /**
   * The flow has an `integrate` step: a conflict `merge` sends back goes to it
   * first, so only the conflicts it cannot settle reach the implementing agent.
   */
  flowIntegrates?: boolean;
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
  /**
   * The factory's step overrides now. Read at each agent step, so a change
   * saved mid-run reaches the steps that have not started yet.
   */
  stepOverrides?: () => Promise<StepOverrides>;
  /** The project's agent defaults (provider, model, effort), under the flow's. */
  projectDefaults?: ProjectAgentDefaults;
  /** Record the options a step ran with, once it has its thread. */
  recordStepOptions?: (entry: StepOptionsEntry) => Promise<void>;
  github: Pick<
    FactoryGithubPort,
    'findPullRequest' | 'pullRequests' | 'branchAhead' | 'commentOnIssue'
  >;
  /**
   * Hand the issue back to a person after a run that ended with no change:
   * take it out of the factory's label queue and mark it for triage. Best
   * effort; the run ends with no change either way.
   */
  releaseIssue?: () => Promise<void>;
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

/** What one agent step ran with, as the run records it. */
export interface StepOptionsEntry extends ResolvedStepOptions {
  threadId: string;
}

/** The agent options a launch or follow-up body carries (unset fields are omitted). */
export interface StepAgentBody {
  provider: string;
  model: string;
  permissionMode: string;
  effort?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
}

/** The body fields of a step's resolved options: every kept field explicit, the rest only when set. */
function stepAgentBody(options: ResolvedStepOptions): StepAgentBody {
  const body: StepAgentBody = {
    provider: options.provider,
    model: options.model,
    permissionMode: options.permissionMode,
  };
  if (options.effort) body.effort = options.effort;
  if (options.allowedTools) body.allowedTools = options.allowedTools;
  if (options.disallowedTools) body.disallowedTools = options.disallowedTools;
  return body;
}

/** Following up on a run's thread, as the enabler. */
export interface FactoryContinuation {
  /** Send `content` with the step's agent options (provider, model, permission mode, …). */
  followUp(
    threadId: string,
    content: string,
    options?: StepAgentBody,
  ): Promise<Result<void, string>>;
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

/** How many changed paths a risk record keeps (the merge queue compares them, D11). */
const MAX_RECORDED_PATHS = 300;

/** A factory step's timeout when the flow sets none: 10 minutes. */
const DEFAULT_STEP_TIMEOUT_MS = 10 * 60_000;

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

/** A stored proof that names its commit and whose verdict allows a merge; null otherwise. */
function heldProofRecord(
  record: RegressionProofRecord | null | undefined,
  testRequired: boolean,
): RegressionProofRecord | null {
  return record?.headSha && proofAllowsMerge(record, testRequired) ? record : null;
}

const PROOF_NOT_CONFIGURED: ActionResult = {
  ok: false,
  error:
    'Regression proof not configured: the flow has no regression_proof rules, so the factory does not merge.',
};

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
  /** A run stacked on its blocker's branch (D10): its base until the blocker lands. */
  const stacking = createStacking({
    stackedOn: deps.stackedOn ?? null,
    defaultBranch: deps.defaultBranch,
    blockerState: deps.blockerState,
    retarget: deps.retarget,
    record: (input) => deps.record(input),
    signal: deps.signal,
  });
  /** The node a regenerable merge (D9) sends a conflict back to, once `merge` named one. */
  let regenerating: string | undefined;

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
  // How the run is named in its thread titles: `#<issue>`, or `run-<id>` without one.
  const label = factoryRunLabel({ id: scope.runId, issueNumber: scope.issueNumber });
  const titlePrefix = `[Factory] ${label} `;
  /**
   * The title prefix of a step's thread: the implementing thread's, or one of
   * its own for a `thread: new` step, so adopting an interrupted launch never
   * mistakes one for the other.
   */
  const titlePrefixOf = (options: ResolvedStepOptions) =>
    options.thread === 'new' ? `[Factory ${options.stepId}] ${label} ` : titlePrefix;
  const titleOf = (options: ResolvedStepOptions) =>
    `${titlePrefixOf(options)}${scope.issueTitle}`.slice(0, 200);

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
  async function adoptInterrupted(
    step: number,
    options: ResolvedStepOptions,
  ): Promise<string | null> {
    const since = pendingLaunch;
    pendingLaunch = null;
    if (!since || step !== threadIds.length) return null;
    const found = await deps.findLaunched(titlePrefixOf(options), since);
    return found && !threadIds.includes(found) ? found : null;
  }

  /** Continue the run's first thread with this step's prompt (a later agent step). */
  async function followUp(
    continuation: FactoryContinuation,
    first: string,
    opts: SpawnAgentOpts,
    options: ResolvedStepOptions,
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
    const sent = await continuation.followUp(first, prompted(opts), stepAgentBody(options));
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

  /** Start a new thread for this step, marked first so a crash in between is adopted. */
  async function launchNew(
    opts: SpawnAgentOpts,
    options: ResolvedStepOptions,
    checkpoint: Checkpoint = noCheckpoint,
  ): Promise<StepThread | ActionResult> {
    const base = await worktreeBase();
    if ('error' in base) return { ok: false, error: base.error };
    const since = new Date().toISOString();
    await checkpoint({ phase: 'launching', since });
    await deps.record({ launchStartedAt: since });
    const own = options.thread === 'new';
    const body: Record<string, unknown> = {
      projectId: scope.projectId,
      title: titleOf(options),
      mode: scope.mode,
      ...base,
      source: 'factory',
      prompt: prompted(opts),
      ...stepAgentBody(options),
    };
    // A worktree thread is created on the run's branch, so the thread, its
    // worktree and the pull request share one branch. A step on its own
    // thread is read-only and reads the branch from the remote instead.
    if (!own) body.branch = scope.branch;
    // A step on its own thread may only read: the runner holds it to that
    // (its OS sandbox), whatever the agent tries; `plan` alone is a prompt.
    if (own) body.readOnly = true;
    const launched = await deps.launch(body);
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
    options: ResolvedStepOptions,
  ): Promise<StepThread | undefined> {
    if (state.phase === 'thread') {
      return { threadId: await rememberThread(state.threadId), after: state.after };
    }
    if (state.phase === 'launching') {
      const found = await deps.findLaunched(titlePrefixOf(options), state.since);
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
  async function journaledThreadFor(
    opts: SpawnAgentOpts,
    options: ResolvedStepOptions,
  ): Promise<StepThread | ActionResult> {
    const execution = opts.execution;
    const checkpoint: Checkpoint = execution
      ? (state) => execution.checkpoint(state)
      : noCheckpoint;
    // The journal resumes the run; the launch marker belongs to the numbering path.
    pendingLaunch = null;
    const saved = STEP_CHECKPOINT.safeParse(execution?.resume?.recorded.data);
    const adopted = saved.success
      ? await adoptCheckpoint(saved.data, checkpoint, options)
      : undefined;
    if (adopted) return adopted;
    const first = threadIds[0];
    if (first && deps.continuation && options.thread !== 'new') {
      return followUp(deps.continuation, first, opts, options, checkpoint);
    }
    return launchNew(opts, options, checkpoint);
  }

  /** The thread of the current agent step: recorded, continued, adopted, or new. */
  async function threadFor(
    opts: SpawnAgentOpts,
    options: ResolvedStepOptions,
    step: number,
  ): Promise<StepThread | ActionResult> {
    const recorded = threadIds[step];
    if (recorded) return { threadId: recorded, replayed: true };
    const first = threadIds[0];
    if (step > 0 && first && deps.continuation && options.thread !== 'new') {
      return followUp(deps.continuation, first, opts, options);
    }
    const adopted = await adoptInterrupted(step, options);
    return adopted ? { threadId: await recordThread(adopted) } : launchNew(opts, options);
  }

  /** The options this agent step runs with, the factory's overrides read now. */
  async function optionsOf(opts: SpawnAgentOpts, index: number): Promise<ResolvedStepOptions> {
    return resolveStepOptions({
      stepId: opts.stepId ?? `step-${index}`,
      step: opts,
      flowDefaults: opts.defaults,
      overrides: (await deps.stepOverrides?.()) ?? {},
      project: deps.projectDefaults,
    });
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
    const record = heldProofRecord(lastProof?.record ?? deps.storedProof, testRequired);
    if (!record || (await pullHeadSha()) !== record.headSha) return null;
    lastProof = { record, testRequired, ok: true, checkPublished: record.checkPublished === true };
    // The check may not have reached GitHub the first time: auto-merge needs it.
    await checkOnGithub(lastProof);
    await count(metrics, { event: 'regression_proof_reused' });
    return { ok: true, output: record.verdict, metadata: { ...lastProof.record, reused: true } };
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
          maxLowRiskLines: deps.maxLowRiskLines,
          sizeIgnoredPaths: deps.sizeIgnoredPaths,
          riskHints: contractOf({ triage: triager.current() })?.riskHints,
        })
      : {
          headSha: sha,
          level: 'high',
          reasons: [`the change could not be read: ${files.error.message}`],
          keys: [UNREADABLE_RISK_KEY],
        };
    if (files.isOk()) {
      risk.changedLines = files.value.files.reduce((n, f) => n + f.additions + f.deletions, 0);
      risk.paths = files.value.files.slice(0, MAX_RECORDED_PATHS).map((f) => f.path);
      deps.onChangeSize?.(risk.changedLines);
    }
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

  /** The `funny/review` status of a verdict carried to a base-merge commit (best effort). */
  async function publishCarriedStatus(verdict: FactoryReviewVerdict): Promise<boolean> {
    const pr = pullRequest();
    if (!pr) return false;
    const from = verdict.carriedFrom ? ` (kept from ${verdict.carriedFrom.slice(0, 8)})` : '';
    const published = await deps.github.pullRequests.publishReview(pr, {
      sha: verdict.sha,
      allowsMerge: reviewAllowsMerge(verdict),
      description: `${reviewHeadline(verdict)}${from}`.slice(0, 140),
    });
    return published.isOk() && published.value.status;
  }

  const enterStage = async (stage: FactoryRunStage) =>
    deps.enterStage
      ? deps.enterStage(stage)
      : deps.record({ state: stage === 'review' ? 'reviewing' : 'merging' });

  const offBranch = deps.continuation?.followUpOffBranch;
  const askAgain =
    offBranch && deps.continuation
      ? { send: offBranch, completedAt: deps.continuation.completedAt }
      : undefined;

  // Triage and review judge a change against the run's issue. A run without
  // one never reaches them: its flow is refused when it has such a step
  // (`validateFlowForSubject`), and the step entries below refuse again. The
  // roles are still built, on a scope whose issue number is never used.
  const roleScope: IssueRunScope = { ...scope, issueNumber: scope.issueNumber ?? 0 };
  const needsIssue = (step: string): ActionResult => ({
    ok: false,
    error: `The ${step} step needs an issue, and this run has none.`,
  });

  const triager = createFactoryTriage({
    scope: roleScope,
    issueUrl: scope.issueUrl ?? null,
    stored: deps.triage ?? null,
    since: deps.admittedAt ?? new Date(0).toISOString(),
    signal: deps.signal,
    launch: deps.launch,
    findLaunched: async (prefix, since) => (await deps.findTriageThread?.(prefix, since)) ?? null,
    waitThread: deps.waitThread,
    finalMessage: async (threadId) => (await deps.lastThreadMessage?.(threadId)) ?? null,
    followUp: askAgain,
    worktreeBase,
    comment: async (body) => {
      const posted = await deps.github.commentOnIssue(reader, roleScope.issueNumber, body);
      return posted.isOk() ? ok(undefined) : err(posted.error.message);
    },
    busyPaths: deps.busyPaths,
    issueUpdatedAt: deps.issueUpdatedAt,
    issueText: deps.issueText,
    hold: deps.holdForPaths,
    split: deps.split,
    exclusive: deps.exclusive,
    record: deps.record,
    count: (event) => count(metrics, { event }),
  });

  const reviewer = createFactoryReviewer({
    scope: roleScope,
    issueUrl: scope.issueUrl ?? null,
    issueText: deps.issueText,
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
    followUp: askAgain,
    contract: () => contractOf({ triage: triager.current() }),
    abandon: deps.abandon,
    worktreeBase,
    otherPullRequests: deps.otherPullRequests,
    acquireSlot: deps.reviewSlot,
    publish: publishVerdict,
    publishStatus: publishCarriedStatus,
    record: deps.record,
    enterReview: () => enterStage('review'),
    count: (event) => count(reviewCounted(metrics, event), { event }),
    integrationOf: (sha) => integration.integrationOf(sha),
    diffBase: () => stacking.diffBase(),
  });

  /** The run's checkout: one step at a time, an early integration included (D8). */
  const workspace = createWorkspaceLock();
  /** Whether the run waits for or holds the merge slot (an early integration leaves it to the queue). */
  let atMerge = false;
  const early = createEarlyIntegration({
    lock: workspace,
    integrate: () => integration.integrate(),
    atMerge: () => atMerge,
    toImplementer: (feedback) => conflictToImplementer(feedback),
    markPending: (at) => deps.record({ integrationPendingAt: at }),
  });
  deps.registerEarly?.(early);
  /** A step that works in the run's checkout: it holds the lock; a pending integration follows it. */
  const inCheckout = <T>(fn: () => Promise<T>): Promise<T> => {
    atMerge = false;
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
    await count({ ...metrics, agentFixes: metrics.agentFixes + 1 }, { event: 'agent_fix_early' });
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
    metrics: () => metrics,
    count: (next, attributes) => count(next, attributes),
    carry: (from, to) => carryChecks(from, to),
    toImplementer: () => mergeRoundToImplementer(),
  });

  /** The enabler reads the repository: the App token capped by their access. */
  const reader = { repo: scope.repo, ownerId: scope.userId, projectId: scope.projectId };

  /** Say the no-change outcome on the issue; a comment that fails is logged, not fatal. */
  async function commentNoChange(issueNumber: number, body: string): Promise<void> {
    const commented = await deps.github.commentOnIssue(reader, issueNumber, body);
    if (commented.isOk()) return;
    log.warn('Issue factory could not comment a no-change outcome on the issue', {
      namespace: 'factory',
      runId: scope.runId,
      issue: issueNumber,
      error: commented.error.message,
    });
  }

  /**
   * The agent pushed no commit and opened no pull request: say so on the issue
   * with its explanation and remove the run's checkout. Not ok, so the flow
   * stops here.
   *
   * With nothing left behind, the agent decided there is nothing to change: the
   * run ends as `no_change` (not a failure) and the issue goes back to a person
   * for triage. The issue is not closed: "nothing to change" is the agent's
   * opinion (an index issue is not done; a bug may not really be fixed).
   *
   * A checkout with uncommitted files or unpushed commits is kept and named in
   * the comment, and the run waits for a person (`waiting_human`, reason `no
   * change`): the agent may have stopped before committing (issue #229 lost 85
   * edited files this way).
   */
  async function noChange(): Promise<ActionResult> {
    const threadId = threadIds[0];
    const explanation = threadId ? await deps.lastThreadMessage?.(threadId) : null;
    const kept = (await deps.removeUnchangedWorktrees?.()) ?? [];
    const body = [NO_CHANGE_LINE, explanation, ...kept.map(keptWorktreeLine)]
      .filter(Boolean)
      .join('\n\n');
    // A run without an issue has none to comment on or hand back: with nothing kept, it is done.
    if (scope.issueNumber !== null) await commentNoChange(scope.issueNumber, body);
    if (kept.length > 0) {
      await deps.record({ state: 'waiting_human', failureReason: NO_CHANGE_REASON });
    } else {
      await deps.releaseIssue?.();
      // The step stays recorded: the run's step chain shows how far it went.
      await deps.record({
        state: scope.issueNumber === null ? 'done' : 'no_change',
        failureReason: null,
      });
    }
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
    // The proof ran in the implementer's checkout, which stays at the commit it
    // pushed: a head that only merged the base into that commit holds its proof
    // (a run resumed after the merge lane updated the branch).
    const provedSha = lastProof?.record.headSha;
    if (provedSha && provedSha !== sha && (await lane.isBaseMergeOf(provedSha, sha))) {
      await carryProof(provedSha, sha);
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

  /**
   * The passing proof of `from` holds for `to`: the merge lane made `to` by
   * merging only the base branch into `from`, and its checks passed there. The
   * proof's tests ran on the implementing agent's worktree, which stays at
   * `from`, so proving `to` again would only prove `from` once more.
   */
  async function carryProof(from: string, to: string): Promise<void> {
    if (!lastProof?.ok || lastProof.record.headSha !== from) return;
    const record: RegressionProofRecord = {
      ...lastProof.record,
      headSha: to,
      carriedFrom: lastProof.record.carriedFrom ?? from,
      checkPublished: false,
    };
    lastProof = { ...lastProof, record, checkPublished: false };
    await deps.record({ regressionProof: record });
    await count(metrics, { event: 'regression_proof_carried' });
  }

  /**
   * `to` merges only the base branch into `from` and settled nothing: what was
   * judged of `from` holds for `to`, its review, its proof, and a member's
   * approval to merge it although it is high risk. Without the approval, every
   * base merge of an approved commit would wait for a person again.
   */
  async function carryChecks(from: string, to: string): Promise<void> {
    await reviewer.carry(from, to);
    await carryProof(from, to);
    await deps.carryMergeApproval?.(from, to);
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

  /**
   * Why the factory does not merge `sha` by itself: the reasons its change is
   * high risk, when no member approved it. Null when it may.
   */
  async function riskReasons(sha: string): Promise<string[] | null> {
    if (deps.autoMerge === 'all') return null;
    const change = await classifyHead();
    if (change?.sha !== sha || change.risk.level !== 'high') return null;
    if (await deps.mergeApproved?.(sha)) return null;
    const refusal = await approvalNotMoved(sha, change.risk.keys);
    if (refusal === null) return null;
    return refusal
      ? [...change.risk.reasons, `a member approved another commit, and ${refusal}`]
      : change.risk.reasons;
  }

  /** Why the approval of another commit does not cover a head, by `approved..head`: asked once. */
  const approvalRefusals = new Map<string, string>();

  /**
   * A member approved another commit of this pull request: move the approval
   * to `sha` when it covers it (openspec factory-approval-survives-integration,
   * D3). Null when `sha` is approved now; else why not ('' when there is no
   * approval to move). The delta is always taken from the commit the member
   * approved, so adjustments cannot add up.
   */
  async function approvalNotMoved(
    sha: string,
    riskKeys: readonly string[] | undefined,
  ): Promise<string | null> {
    const approval = (await deps.mergeApproval?.()) ?? null;
    if (!approval || approval.sha === sha) return '';
    const approved = approval.carriedFrom ?? approval.sha;
    const asked = `${approved}..${sha}`;
    const known = approvalRefusals.get(asked);
    if (known !== undefined) return known;
    const coverage = approvalCovers({
      delta: await changeSince(approved, sha),
      maxAdjustLines: deps.approvalAdjustMaxLines ?? 0,
      approvedRiskKeys: approval.riskKeys,
      riskKeys,
    });
    if (coverage.covers) {
      const { kind, lines, files } = coverage;
      await deps.carryMergeApproval?.(approval.sha, sha, { kind, lines, files });
      await count(metrics, { event: `merge_approval_moved_${kind}` });
      // The move is a compare-and-set: a new approval written meanwhile wins.
      if (await deps.mergeApproved?.(sha)) {
        await announceApprovalMove({
          userId: approval.userId,
          from: approved,
          to: sha,
          kind,
          lines,
          files,
        });
        return null;
      }
    }
    const reason = coverage.covers ? 'the approval changed meanwhile' : coverage.reason;
    approvalRefusals.set(asked, reason);
    return reason;
  }

  /**
   * Say where the approval went (D6): a comment on the pull request and a row
   * in the approver's activities. The stored move is the record; a comment
   * that fails is logged and never stops the merge.
   */
  async function announceApprovalMove(move: ApprovalMove): Promise<void> {
    await deps.onApprovalMoved?.(move);
    const pr = pullRequest();
    if (!pr) return;
    const commented = await deps.github.commentOnIssue(
      reader,
      pr.number,
      approvalMoveComment(move),
    );
    if (commented.isOk()) return;
    log.warn('Issue factory could not comment a moved merge approval on the pull request', {
      namespace: 'factory',
      runId: scope.runId,
      from: move.from,
      to: move.to,
      error: commented.error.message,
    });
  }

  /** How the pull request's change differs at `from` and at `to`, from the run's runner; null when it cannot say. */
  async function changeSince(from: string, to: string): Promise<ChangeDelta | null> {
    const pr = pullRequest();
    const threadId = threadIds[0];
    if (!pr || !threadId || !deps.steps) return null;
    const head = await deps.github.pullRequests.pullHead(pr);
    if (head.isErr()) return null;
    const delta = await changeDeltaOnRunner(
      deps.steps,
      threadId,
      { from, to, baseBranch: head.value.baseRef, branch: scope.branch },
      deps.signal,
    );
    if (delta.isErr()) {
      log.warn('Issue factory could not compare a change with its approved commit', {
        namespace: 'factory',
        runId: scope.runId,
        from,
        to,
        error: delta.error,
      });
      return null;
    }
    return delta.value;
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
    if (metrics.mergeRoundsToAgent >= MAX_MERGE_ROUNDS_TO_AGENT) {
      return holdMerge(
        MERGE_HOLD_REASONS.mergeRounds,
        `Not merged: ${MAX_MERGE_ROUNDS_TO_AGENT} rounds of fixes by the agent did not get the change to merge with its base. A person has to look at it.`,
      );
    }
    await count(
      { ...metrics, mergeRoundsToAgent: metrics.mergeRoundsToAgent + 1 },
      { event: 'merge_round_to_agent' },
    );
    return null;
  }

  /** `merge` sent the change back to the implementing agent: ok, so the flow's loop can act. */
  async function sentBack(why: 'conflict' | 'checks', feedback: string): Promise<ActionResult> {
    // A regenerable change (D9) goes back to the node that produces it: no agent round.
    const regenerate = why === 'conflict' ? regenerating : undefined;
    // A conflict goes to the flow's integrate step first, which may settle it alone.
    if (!regenerate && (why === 'checks' || !deps.flowIntegrates)) {
      const parked = await mergeRoundToImplementer();
      if (parked) return parked;
    }
    await count(
      { ...metrics, mergeSentBack: metrics.mergeSentBack + 1 },
      { event: `merge_sent_back_${why}` },
    );
    const metadata: Record<string, unknown> = { outcome: 'sent_back', why, feedback };
    if (regenerate) metadata.regenerate = regenerate;
    return { ok: true, output: 'sent_back', metadata };
  }

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
        count(withBatchStats(metrics, stats, flake), { event: 'batch_ended' }),
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
    atMerge = true;
    await enterStage('merge');
    const retarget = await stacking.retargetIfLanded();
    if (retarget === 'retargeted') {
      return sentBack(
        'conflict',
        'The pull request it was stacked on merged: this pull request now targets the default branch, and the base is merged in before it merges.',
      );
    }
    if (typeof retarget === 'object') return holdMerge(MERGE_HOLD_REASONS.stacked, retarget.error);
    if (opts.regenerate && regenerating !== opts.regenerate) {
      regenerating = opts.regenerate;
      await deps.record({ regenerateNode: opts.regenerate });
    }
    return null;
  }

  /** `mergeHeld` on entry to `merge`, with the risk hold on a head that includes the base. */
  async function heldOnEntry(
    opts: MergeOpts,
    sha: string,
    baseRef: string,
  ): Promise<ActionResult | null> {
    return (await reviewHeld(opts, sha)) ?? (await heldOnCurrentBase(sha, baseRef));
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
    const proof = await proofOfHead(config, sha);
    if ('refused' in proof) return proof.refused;
    // Auto-merge only on the proved commit whose check GitHub can hold.
    return ci.merge({
      ...opts,
      sha,
      autoMergeWhenHeld: await checkOnGithub(proof.held),
    });
  }

  /**
   * A flow's `run_command`, run by the runner in the run's own checkout (the
   * implementing thread's), never on the server. The exit code decides: a
   * non-zero exit, a timeout or a stop fails the step with the end of its output.
   */
  async function runCommandStep(opts: RunCommandOpts): Promise<ActionResult> {
    if (!deps.steps) {
      return refused('run_command', 'this server cannot run factory steps on a runner.');
    }
    const threadId = threadIds[0];
    if (!threadId) {
      return {
        ok: false,
        error: 'run_command needs the run checkout: an agent step has to start it first.',
      };
    }
    const timeoutMs = opts.timeout ?? DEFAULT_STEP_TIMEOUT_MS;
    const run = await runStepOnRunner(
      deps.steps,
      threadId,
      { kind: 'command', command: opts.command, timeoutMs },
      deps.signal,
    );
    if (run.kind === 'unavailable') {
      return { ok: false, error: `run_command could not run: ${run.why}` };
    }
    if (run.result.kind !== 'command')
      return { ok: false, error: 'run_command: unexpected result.' };
    const { outcome, exitCode, stdout, stderr, durationMs } = run.result;
    const metadata = { outcome, exitCode, stdout, stderr, durationMs };
    if (outcome === 'passed') return { ok: true, output: stdout, metadata };
    const tail = (stderr.trim() || stdout.trim()).slice(-4000);
    const how = outcome === 'failed' ? `exited ${exitCode}` : outcome;
    return { ok: false, error: `The command ${how}:\n${tail}`, metadata };
  }

  /** An agent step: a thread on the enabler's runner (the first, or a follow-up on it). */
  async function agentStep(opts: SpawnAgentOpts): Promise<ActionResult> {
    const index = agentSteps++;
    const options = await optionsOf(opts, index);
    const step =
      (deps.legacyReplay ?? true)
        ? await threadFor(opts, options, index)
        : await journaledThreadFor(opts, options);
    if (!('threadId' in step)) return step;
    if (!step.replayed) await deps.recordStepOptions?.({ ...options, threadId: step.threadId });
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
  }

  return {
    spawnAgent: (opts) => inCheckout(() => agentStep(opts)),

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
      if (head && opts.earlyReview && scope.issueNumber !== null) {
        await reviewer.startEarly(head.sha, opts.earlyReview);
      }
      const result = await ci.waitCi(opts);
      const verdict = result.metadata?.verdict;
      await count(countCiResult(metrics, result), { event: 'ci_round', verdict: String(verdict) });
      if (!result.ok) return result;
      // A stacked run waits here for its blocker (D10), holding no merge slot.
      const stuck = await stacking.waitForBlocker();
      return stuck ? { ok: false, error: stuck, metadata: { outcome: 'blocker-gone' } } : result;
    },

    merge: async (opts) => (scope.issueNumber === null ? needsIssue('merge') : provedMerge(opts)),

    regressionProof: async (opts) =>
      scope.issueNumber === null ? needsIssue('regression_proof') : runRegressionProof(opts),

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

    runCommand: (opts) => inCheckout(() => runCommandStep(opts)),

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
