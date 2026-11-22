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

export const saveFactorySettingsInput = z
  .object({
    projectId,
    enabled: z.boolean(),
    mode: factoryMode.optional(),
    label: label.optional(),
    flowName: flowName.optional(),
    maxConcurrent: z.number().int().min(1).max(20).optional(),
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
});

export type FactoryRegressionProof = z.infer<typeof factoryRegressionProofSchema>;

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
}

export const EMPTY_FACTORY_RUN_METRICS: FactoryRunMetrics = {
  ciRounds: 0,
  ciRed: 0,
  conflicts: 0,
  ciBlocked: 0,
  ciTimeouts: 0,
  agentFixes: 0,
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
