/**
 * The issue factory of a project (change issue-factory): inputs and answers of
 * the `factory` tRPC procedures. Each user configures their own factory for a
 * project; runs are written by the server's watcher and only read here.
 */

import { z } from 'zod';

const projectId = z.string().min(1);

/**
 * A flow is named like a workflow file (`issue-to-merge`): it is looked up in
 * the workflow catalog, so path separators and leading dots are refused.
 */
const flowName = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9][a-z0-9._-]{0,63}$/,
    'Flow names use lowercase letters, digits, ".", "_" and "-"',
  );

/**
 * One GitHub label. A comma would make the issue search match several labels
 * at once (GitHub reads `labels=a,b` as "both"), so it is refused.
 */
const label = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => !value.includes(','), 'A label cannot contain a comma');

export const factoryProjectInput = z.object({ projectId }).strict();

/** One run of the caller's factory for the project (stop, retry). */
export const factoryRunInput = z.object({ projectId, runId: z.string().min(1) }).strict();

/**
 * What a factory admits (change factory-manual-queue): `manual`, only the
 * issues sent to it; `automatic`, also the open issues carrying its label.
 */
export const factoryMode = z.enum(['manual', 'automatic']);
export type FactoryMode = z.infer<typeof factoryMode>;

/**
 * Which changes a factory merges by itself (change factory-agent-roles):
 * `low_risk`, only changes the server classed low risk; `all`, every reviewed one.
 */
export type FactoryAutoMerge = 'low_risk' | 'all';

/** At most this many sensitive path globs per factory. */
export const MAX_SENSITIVE_PATHS = 50;

/** The stage whose limit (one per repository and base branch) no setting changes. */
export const MERGE_STAGE = 'merge';

export const saveFactorySettingsInput = z
  .object({
    projectId,
    enabled: z.boolean(),
    mode: factoryMode.optional(),
    label: label.optional(),
    flowName: flowName.optional(),
    maxConcurrent: z.number().int().min(1).max(20).optional(),
    autoMerge: z.enum(['low_risk', 'all']).optional(),
    sensitivePaths: z.array(z.string().trim().min(1).max(200)).max(MAX_SENSITIVE_PATHS).optional(),
    stageLimits: z
      .record(z.string().min(1).max(64), z.number().int().min(1).max(20))
      .refine(
        (limits) => !(MERGE_STAGE in limits),
        'The merge limit cannot be changed: merges are one at a time per repository',
      )
      .optional(),
  })
  .strict();

export type SaveFactorySettingsInput = z.input<typeof saveFactorySettingsInput>;

export interface FactorySettings {
  projectId: string;
  /** Running (true) or paused (false); separate from the mode. */
  enabled: boolean;
  mode: FactoryMode;
  /** The label automatic mode admits; kept (and unused) in manual mode. */
  label: string;
  flowName: string;
  maxConcurrent: number;
  /** Which reviewed changes the factory merges by itself. */
  autoMerge: FactoryAutoMerge;
  /** Globs that make a change high risk, besides the default list. */
  sensitivePaths: string[];
  /** Runs inside a flow node at once, per node id; replaces the flow's own limit. */
  stageLimits: Record<string, number>;
  /** Why the factory cannot make progress now (e.g. its runner is offline), or null. */
  blockedReason: string | null;
  updatedAt: string;
}

export type FactoryRunState =
  /** Sent to the factory and waiting in its queue; holds no concurrency slot. */
  | 'requested'
  | 'queued'
  | 'working'
  | 'pr_open'
  | 'waiting_ci'
  | 'fixing'
  /** The reviewer judges the pull request's head commit. */
  | 'reviewing'
  /** In the merge step: waiting for the repository's merge slot, or merging. */
  | 'merging'
  | 'waiting_human'
  | 'merged'
  | 'failed'
  | 'stopped';

export interface FactoryRun {
  id: string;
  factoryId: string;
  issueNumber: number;
  prUrl: string | null;
  state: FactoryRunState;
  currentStep: string | null;
  threadIds: string[];
  /** When the row was written: the send time for a sent issue. */
  startedAt: string;
  /** When the run left the queue and its flow could start; null while `requested`. */
  admittedAt: string | null;
  completedAt: string | null;
  /** How the issue came in: sent from funny, or found by the label (automatic mode). */
  source: FactoryRunSource;
  /** The flow the run executes; null on runs from before runs recorded their own. */
  flowName: string | null;
  /** Position in the queue while `requested` (lower goes first). */
  queueOrder: number | null;
  /** Why a `requested` run is not admitted yet, or null. */
  waitReason: FactoryWaitReason | null;
  /** The flow's step names in order, once its flow started; empty before (and on older runs). */
  flowSteps: string[];
  /** Why the run failed (the flow's error), or null. */
  failureReason: string | null;
  /** How integrating the run's pull request went; zeros before its CI was looked at. */
  metrics: FactoryRunMetrics;
  /** The last regression proof of the run's pull request, or null before one ran. */
  regressionProof: FactoryRegressionProof | null;
  /** The review verdicts of the run's pull request, one per commit, oldest first. */
  reviews: FactoryReviewVerdict[];
  /** The risk class of the pull request's last classified commit, or null before one. */
  risk: FactoryRisk | null;
}

/**
 * A regression proof as the run stores it (change factory-quality-gates): the
 * changed tests must pass on the head and fail by an assertion on the base.
 */
export const factoryRegressionProofSchema = z.object({
  /** The commit proved. */
  headSha: z.string(),
  verdict: z.enum(['pass', 'fail', 'skipped']),
  /** Why it failed or was skipped. */
  finding: z.string().optional(),
  /** The changed test files that ran. */
  files: z.array(z.string()).optional(),
  /** The commands that ran them. */
  commands: z.array(z.string()).optional(),
  /** The merge-base the tests ran against. */
  baseSha: z.string().optional(),
  /** A pass: the base's failing output (the evidence); a fail: the failing run's. */
  outputTail: z.string().optional(),
  ranAt: z.string(),
  /**
   * Whether the proof is on GitHub as its commit's check. False: publishing
   * failed and is tried again; absent on proofs stored before it was tracked.
   */
  checkPublished: z.boolean().optional(),
});

export type FactoryRegressionProof = z.infer<typeof factoryRegressionProofSchema>;

/** A run of the caller's factories as the factory view lists it: with its project. */
export interface FactoryQueueRun extends FactoryRun {
  projectId: string;
}

/** A run of the caller's factories as the factory view lists it: with its project. */
export interface FactoryQueueRun extends FactoryRun {
  projectId: string;
}

/** A run of the caller's factories as the factory view lists it: with its project. */
export interface FactoryQueueRun extends FactoryRun {
  projectId: string;
}

/**
 * Counters of one run's integration, written as the run goes. They measure
 * how much integrating costs (CI rounds, conflicts, agent fixes) so a factory
 * can be tuned. New counters are added here with a 0 default; stored rows
 * without them read as 0.
 */
export interface FactoryRunMetrics {
  /** `wait_ci` steps that reached a verdict (each one is a CI round). */
  ciRounds: number;
  /** Rounds that ended with failing checks. */
  ciRed: number;
  /** Rounds that ended with the pull request conflicting with its base branch. */
  conflicts: number;
  /** Rounds that ended with checks that could not run (they need a person). */
  ciBlocked: number;
  /** Rounds whose checks did not finish in time. */
  ciTimeouts: number;
  /** Agent follow-ups after the pull request was opened (fix steps). */
  agentFixes: number;
  /** Review verdicts the run got (one per reviewed commit). */
  reviews: number;
  /** Verdicts that sent the change back to the implementing agent. */
  reviewFails: number;
  /** Times `merge` left the run for a person (no review, review failed, high risk, rewritten). */
  mergeHolds: number;
  /** Times `merge` sent the change back (a conflict, or checks failing on the current base). */
  mergeSentBack: number;
}

export const EMPTY_FACTORY_RUN_METRICS: FactoryRunMetrics = {
  ciRounds: 0,
  ciRed: 0,
  conflicts: 0,
  ciBlocked: 0,
  ciTimeouts: 0,
  agentFixes: 0,
  reviews: 0,
  reviewFails: 0,
  mergeHolds: 0,
  mergeSentBack: 0,
};

export type FactoryRunSource = 'manual' | 'label';

/**
 * Why a queued issue is not admitted yet: it waits on another one (GitHub's
 * "blocked by" relation; `blockers` are the issue numbers in the same
 * repository that hold it back), or its flow could never merge
 * (`proof-not-configured`, no blockers).
 */
export interface FactoryWaitReason {
  kind:
    | 'blocker-not-sent'
    | 'blocker-in-progress'
    | 'blocker-waiting-merge'
    | 'blocker-failed'
    /** A blocker in another repository: it counts only by its issue state. */
    | 'blocker-other-repo'
    | 'circular'
    | 'blockers-unreadable'
    /** Its flow's merge needs a regression proof and the flow has no proof rules. */
    | 'proof-not-configured';
  blockers: number[];
}

/** At most this many issues per send. */
export const MAX_ISSUES_PER_SEND = 50;

const issueNumber = z.number().int().positive();

/** Send chosen issues of the project's repository to the caller's own factory. */
export const submitFactoryIssuesInput = z
  .object({
    projectId,
    issueNumbers: z.array(issueNumber).min(1).max(MAX_ISSUES_PER_SEND),
    flowName,
  })
  .strict();

export type SubmitFactoryIssuesInput = z.input<typeof submitFactoryIssuesInput>;

/** Why one issue of a send was not queued. */
export type FactorySubmitRefusal =
  | 'not-found'
  | 'closed'
  | 'pull-request'
  | 'already-in-factory'
  | 'unreadable';

export interface FactorySubmitResult {
  /** The queued issues, in queue order. */
  accepted: number[];
  refused: Array<{ issue: number; reason: FactorySubmitRefusal; message: string }>;
}

/** A flow a send may pick. */
export interface FactoryFlowOption {
  name: string;
  source: 'built-in' | 'repository';
}

/** One flow of the caller's factory, by name (its YAML). */
export const factoryFlowInput = z.object({ projectId, flowName }).strict();

/**
 * The YAML a flow runs: the repository's copy on its default branch, or the
 * built-in of that name, as the factory would load it.
 */
export interface FactoryFlowDefinition {
  name: string;
  source: FactoryFlowOption['source'];
  /** The file in the repository (`.funny/workflows/<name>.yaml`); null for a built-in. */
  path: string | null;
  yaml: string;
}

/** The open blockers of some issues (the send bar's warning). */
export const factoryBlockersInput = z
  .object({ projectId, issueNumbers: z.array(issueNumber).min(1).max(MAX_ISSUES_PER_SEND) })
  .strict();

export interface FactoryIssueBlockers {
  issue: number;
  /** Open blockers in the same repository, and whether the caller's factory has a run for each. */
  blockers: Array<{ issue: number; inFactory: boolean }>;
}

/** What "Clear queue" / "Stop all" did. */
export interface FactoryQueueClearResult {
  /** Waiting issues removed from the queue. */
  cleared: number;
  /** Runs in progress that were stopped (`stopAll` only). */
  stopped: number;
}

/**
 * Role results (change factory-agent-roles, D2): what a read-only factory
 * agent ends with, as one fenced `json` block the server validates. Unknown
 * fields are dropped; the bounds keep a verdict small enough to store and post.
 */
export const factoryFindingSeverity = z.enum(['critical', 'high', 'medium', 'low']);
export type FactoryFindingSeverity = z.infer<typeof factoryFindingSeverity>;

export const factoryReviewFindingSchema = z.object({
  severity: factoryFindingSeverity,
  /** One line saying what is wrong. */
  title: z.string().trim().min(1).max(300),
  detail: z.string().max(4000).optional(),
  /** The file the finding is about, relative to the repository root. */
  path: z.string().max(500).optional(),
  line: z.number().int().positive().optional(),
});
export type FactoryReviewFinding = z.infer<typeof factoryReviewFindingSchema>;

/** The reviewer's verdict on one commit of the run's pull request. */
export const factoryReviewResultSchema = z.object({
  /**
   * The commit judged: the verdict holds for no other one. The reader refuses
   * a result whose commit is not the one the server asked about.
   */
  sha: z.string().trim().min(1).max(64),
  verdict: z.enum(['pass', 'fail']),
  summary: z.string().max(4000).optional(),
  findings: z.array(factoryReviewFindingSchema).max(50).default([]),
});
export type FactoryReviewResult = z.infer<typeof factoryReviewResultSchema>;

/** The findings that send a change back to the implementer. */
export function blockingReviewFindings(result: FactoryReviewResult): FactoryReviewFinding[] {
  return result.findings.filter(
    (finding) => finding.severity === 'critical' || finding.severity === 'high',
  );
}

/**
 * Whether a review lets the change go on: a `pass`, or a `fail` whose findings
 * are all below `high` (a pass with comments). A `fail` that lists no finding
 * blocks: the reviewer said no without saying why.
 */
export function reviewAllowsMerge(result: FactoryReviewResult): boolean {
  if (result.verdict === 'pass') return true;
  return result.findings.length > 0 && blockingReviewFindings(result).length === 0;
}

/** A review verdict as the run stores it: the validated result, and where it came from. */
export const factoryReviewVerdictSchema = factoryReviewResultSchema.extend({
  /** The reviewer's thread. */
  threadId: z.string().optional(),
  /**
   * The reviewed commit this verdict was carried from: `sha` is a merge of it
   * with the base branch (update-branch), so the pull request's own change is
   * the one that was reviewed.
   */
  carriedFrom: z.string().optional(),
  reviewedAt: z.string(),
  /** Whether the verdict is on the pull request as a review comment. */
  published: z.boolean().optional(),
  /**
   * Whether the `funny/review` status is on the commit. False while the App's
   * installation has not accepted `statuses: write`.
   */
  statusPublished: z.boolean().optional(),
});
export type FactoryReviewVerdict = z.infer<typeof factoryReviewVerdictSchema>;

/** At most this many verdicts are kept per run (the newest). */
export const MAX_STORED_REVIEWS = 20;

/**
 * The risk class of one commit of the run's pull request, decided by the
 * server from the diff. No agent result changes it.
 */
export const factoryRiskSchema = z.object({
  headSha: z.string(),
  level: z.enum(['low', 'high']),
  /** Why it is high, in the order found; empty for low. */
  reasons: z.array(z.string()),
});
export type FactoryRisk = z.infer<typeof factoryRiskSchema>;
