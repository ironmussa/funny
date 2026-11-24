/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: application
 *
 * What the factory's server `ActionProvider` (`factory-action-provider.ts`)
 * is built from, and the state its step modules share while a run executes.
 */

import type {
  FactoryAutoMerge,
  FactoryReviewVerdict,
  FactoryRisk,
  FactoryRunMetrics,
  FactoryStackedOn,
  FactoryTriage,
} from '@funny/shared/contracts/factory';
import type { IntegrateConfig } from '@funny/workflows';
import type { Result } from 'neverthrow';

import type { StartedThread, StartThreadError } from '../runner-thread-launcher.js';
import type { WaitCiOptions } from './factory-ci-actions.js';
import type { EarlyIntegration } from './factory-early-integration.js';
import type { FactoryGithubPort } from './factory-github.js';
import type { FactoryIssueText } from './factory-issue-text.js';
import type { FactoryProofDeps } from './factory-proof-runner.js';
import type { FactoryPullRequestRef } from './factory-pull-requests.js';
import type { FactoryQueuePort } from './factory-queue-port.js';
import type { FactoryRunStage, RegressionProofRecord, UpdateRunInput } from './factory-runs.js';
import type { BlockerState } from './factory-stacking.js';
import type {
  ProjectAgentDefaults,
  ResolvedStepOptions,
  StepOverrides,
} from './factory-step-options.js';
import type { FactoryStepDeps } from './factory-step-runner.js';
import type { TestWeakeningFinding } from './factory-test-weakening.js';
import type { KeptWorktree } from './factory-thread-requests.js';
import type { ThreadOutcome, WaitAfter } from './factory-thread-waits.js';
import type { FactorySplitDeps } from './factory-triage.js';

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
  /** The factory's globs left out of a change's size. */
  sizeIgnoredPaths?: readonly string[];
  /** Which reviewed changes the factory merges by itself (default: only low-risk ones). */
  autoMerge?: FactoryAutoMerge;
  /**
   * Whether a member approved merging `sha` although it is high risk, read
   * when the merge gate runs (the approval is written while the run waits).
   */
  mergeApproved?: (sha: string) => Promise<boolean>;
  /**
   * Move a member's merge approval of `from` to `to`, a merge of `from` with
   * the base branch that settled nothing (as the review and the proof move).
   */
  carryMergeApproval?: (from: string, to: string) => Promise<void>;
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

/** What a run's step modules read and change while its flow executes. */
export interface ProviderState {
  /** Thread ids of the run's agent steps, in order (the same array throughout). */
  readonly threadIds: string[];
  prUrl: string | null;
  /** Set while the run's next agent thread may be starting (cleared once looked at). */
  pendingLaunch: string | null;
  metrics: FactoryRunMetrics;
  /** How many agent steps this execution has called. */
  agentSteps: number;
  /**
   * The last proof this execution ran: its record (which commit), whether its
   * verdict allows a merge, and whether its check is on GitHub (auto-merge
   * needs it).
   */
  lastProof: HeldProof | null;
  /**
   * What the server found in the last classified commit of the pull request:
   * its weakened tests and its risk class (change factory-agent-roles, D6).
   */
  classified: ClassifiedHead | null;
  /** The node a regenerable merge (D9) sends a conflict back to, once `merge` named one. */
  regenerating: string | undefined;
  /** Whether the run waits for or holds the merge slot (an early integration leaves it to the queue). */
  atMerge: boolean;
  /** The `wait_ci` options of the flow's last look, reused when the merge waits on a new head. */
  lastWaitCi: WaitCiOptions;
}

/** What every step module of the provider is given. */
export interface ProviderContext {
  deps: FactoryActionProviderDeps;
  scope: FactoryRunScope;
  state: ProviderState;
  /** Add to the run's counters and store them with the run. */
  count(next: FactoryRunMetrics | null, attributes: Record<string, string>): Promise<void>;
  /** The run's pull request, once it has one. */
  pullRequest(): FactoryPullRequestRef | null;
}
