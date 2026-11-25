/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: model
 * @domain layer: application
 *
 * The types, constants and pure helpers of the factory's `ActionProvider`
 * (`../factory-action-provider.ts`), shared by the modules it is split into.
 */

import {
  type FactoryApprovalGap,
  type FactoryApprovalMove,
  type FactoryAutoMerge,
  type FactoryMergeApproval,
  type FactoryReviewVerdict,
  type FactoryRisk,
  type FactoryRunMetrics,
  type FactoryStackedOn,
  type FactoryTriage,
} from '@funny/shared/contracts/factory';
import type { IntegrateConfig } from '@funny/workflows';
import type { ActionResult, SpawnAgentOpts } from '@funny/workflows/compiler';
import type { Result } from 'neverthrow';
import { z } from 'zod';

import type { StartedThread, StartThreadError } from '../../runner-thread-launcher.js';
import type { ApprovalMove } from '../factory-approval-carry.js';
import type { EarlyIntegration } from '../factory-early-integration.js';
import type { FactoryGithubPort } from '../factory-github.js';
import type { FactoryIssueText } from '../factory-issue-text.js';
import { proofAllowsMerge, type FactoryProofDeps } from '../factory-proof-runner.js';
import type { FactoryQueuePort } from '../factory-queue-port.js';
import {
  HIGH_RISK_HOLD,
  type FactoryRunStage,
  type RegressionProofRecord,
  type UpdateRunInput,
} from '../factory-runs.js';
import type { BlockerState } from '../factory-stacking.js';
import type {
  ProjectAgentDefaults,
  ResolvedStepOptions,
  StepOverrides,
} from '../factory-step-options.js';
import type { FactoryStepDeps } from '../factory-step-runner.js';
import type { TestWeakeningFinding } from '../factory-test-weakening.js';
import type { KeptWorktree } from '../factory-thread-requests.js';
import type { ThreadOutcome, WaitAfter } from '../factory-thread-waits.js';
import type { BusyPaths, FactorySplitDeps } from '../factory-triage.js';

/**
 * A proof the agent can fix (its test): the flows retry it with the agent.
 * Matched by `should_retry: "$contains(error, 'Regression proof failed')"`.
 */
export const proofFailed = (why: string): ActionResult => ({
  ok: false,
  error: `Regression proof failed: ${why}`,
});

/** A proof that could not run or decide (runner, setup, time): no agent fix is tried. */
export const proofUnavailable = (why: string): ActionResult => ({
  ok: false,
  error: `Regression proof unavailable: ${why}`,
});

/** What a "no change" comment says about a checkout that was kept. */
export function keptWorktreeLine(kept: KeptWorktree): string {
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
  /** GitHub refused the merge each time because a branch had just moved. */
  baseMoving: 'base keeps moving',
} as const;

/**
 * Merges GitHub may refuse in one visit to `merge` because the base or the
 * head moved, before the run waits for a person (openspec
 * factory-merge-fewer-bounces, D1). Each one costs a round of checks.
 */
export const MAX_STALE_MERGES = 3;

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
  /**
   * Whether a member marked the run as a lint cleanup, read from the row when
   * a commit is classed (a member may mark it while the run waits).
   */
  lintCleanup?: () => Promise<boolean>;
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
   * True when the approval moved.
   */
  carryMergeApproval?: (
    from: string,
    to: string,
    move?: Pick<FactoryApprovalMove, 'kind' | 'lines' | 'files' | 'baseFiles'>,
  ) => Promise<boolean>;
  /**
   * Record on the merge approval of `approved` why it does not cover a later
   * commit and what differs (openspec factory-merge-fewer-bounces, D2).
   */
  noteApprovalGap?: (approved: string, gap: FactoryApprovalGap) => Promise<void>;
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
  busyPaths?(): Promise<BusyPaths[]>;
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
  /** The last error the thread's agent reported since `since` (a failed turn's cause). */
  lastAgentError?: (threadId: string, since: string) => Promise<string | null>;
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
  launch(body: FactoryLaunchBody): Promise<Result<StartedThread, StartThreadError>>;
  /** Resolves with the thread's terminal status (or why it never will reach one). */
  waitThread(threadId: string, signal: AbortSignal, after?: WaitAfter): Promise<ThreadOutcome>;
  /** The triage and review threads' wait, which may report `idle` (`waitRoleThread` of the flow runs). */
  waitRoleThread?(threadId: string, signal: AbortSignal, after?: WaitAfter): Promise<ThreadOutcome>;
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

/**
 * The agent options a launch or follow-up body carries (unset fields are
 * omitted). A type alias, not an interface, so it fits a creation payload.
 */
export type StepAgentBody = {
  provider: string;
  model: string;
  permissionMode: string;
  effort?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
};

/** The body fields of a step's resolved options: every kept field explicit, the rest only when set. */
export function stepAgentBody(options: ResolvedStepOptions): StepAgentBody {
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

/**
 * What the factory starts a thread with: the fields of the runner's
 * thread-creation request (`createThreadSchema`) it sets. In `sandbox` mode
 * the watcher sends it to the sandbox thread launcher instead (`launchFor`).
 * A type alias, not an interface, so it stays a creation payload.
 */
export type FactoryLaunchBody = {
  projectId: string;
  title: string;
  mode: FactoryThreadMode;
  source: 'factory';
  prompt: string;
  baseBranch?: string;
  /** Start the worktree from `origin/<baseBranch>`. */
  baseFromRemote?: boolean;
  /** The worktree's branch: the run's, so the thread and its pull request share it. */
  branch?: string;
  /** Refuse the launch (409) when another worktree holds `branch`, never use another one. */
  requireBranch?: boolean;
  /** The agent may only read (`threads.read_only`). */
  readOnly?: boolean;
  /** What a read-only agent reads besides its checkout (the issue's text). */
  roleInputs?: Record<string, string>;
  provider?: string;
  model?: string;
  permissionMode?: string;
  effort?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
};

/**
 * The metadata of a `merge` that sent the change back: why, what the agent
 * reads, and the node that regenerates it (when one does).
 */
export type SentBackMetadata = {
  outcome: 'sent_back';
  why: 'conflict' | 'checks';
  feedback: string;
  regenerate?: string;
};

/** The thread an agent step waits on; `after` when a follow-up runs it again. */
export interface StepThread {
  threadId: string;
  after?: WaitAfter;
  /** A step recorded before a resume, retry or take-over. */
  replayed?: boolean;
}

/**
 * What an agent step records in the journal about its work in progress, so
 * a resumed execution adopts it instead of starting it again.
 */
export const STEP_CHECKPOINT = z.discriminatedUnion('phase', [
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
export type StepCheckpoint = z.infer<typeof STEP_CHECKPOINT>;

/** Record a checkpoint of the step in progress (a no-op outside a journaled run). */
export type Checkpoint = (state: StepCheckpoint) => Promise<void>;

export const noCheckpoint: Checkpoint = async () => {};

/** Allowance for the runner's clock when comparing its timestamps with the server's. */
export const CLOCK_SLACK_MS = 60 * 1000;

/** How many changed paths a risk record keeps (the merge queue compares them, D11). */
export const MAX_RECORDED_PATHS = 300;

/** A factory step's timeout when the flow sets none: 10 minutes. */
export const DEFAULT_STEP_TIMEOUT_MS = 10 * 60_000;

export const refused = (step: string, why: string): ActionResult => ({
  ok: false,
  error: `${step} is not available in a factory flow: ${why}`,
});

export function prompted(opts: SpawnAgentOpts): string {
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
export interface ClassifiedHead {
  sha: string;
  findings: TestWeakeningFinding[];
  risk: FactoryRisk;
}

/** A proof the merge gate holds: its record, and what publishing it needs. */
export interface HeldProof {
  record: RegressionProofRecord;
  /** Whether this issue needs a regression test (decides the check's conclusion). */
  testRequired: boolean;
  /** Its verdict allows a merge. */
  ok: boolean;
  /** Its check is on GitHub. */
  checkPublished: boolean;
}

/** A stored proof that names its commit and whose verdict allows a merge; null otherwise. */
export function heldProofRecord(
  record: RegressionProofRecord | null | undefined,
  testRequired: boolean,
): RegressionProofRecord | null {
  return record?.headSha && proofAllowsMerge(record, testRequired) ? record : null;
}

export const PROOF_NOT_CONFIGURED: ActionResult = {
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

export function outcomeResult(threadId: string, outcome: ThreadOutcome): ActionResult {
  if (outcome.status === 'completed') {
    return { ok: true, output: outcome.output, metadata: { threadId } };
  }
  return {
    ok: false,
    error: outcome.reason ?? `The agent thread ended ${outcome.status}.`,
    metadata: { threadId, status: outcome.status },
  };
}
