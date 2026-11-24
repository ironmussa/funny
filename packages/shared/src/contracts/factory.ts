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

/**
 * A change with more counted lines than this is high risk, unless the factory
 * sets its own limit (`maxLowRiskLines`, within `LOW_RISK_LINES_RANGE`).
 */
export const DEFAULT_MAX_LOW_RISK_LINES = 400;
export const LOW_RISK_LINES_RANGE = { min: 10, max: 100_000 } as const;

/** At most this many globs a factory leaves out of a change's size. */
export const MAX_SIZE_IGNORED_PATHS = 50;

/** The stage whose limit (one per repository and base branch) no setting changes. */
export const MERGE_STAGE = 'merge';

/**
 * The merge queue's batches (openspec factory-integration D2): how many ready
 * pull requests one batch tests together (1: one at a time), and how long it
 * waits to gather them.
 */
export const factoryBatchSchema = z
  .object({
    size: z.number().int().min(1).max(10),
    waitSeconds: z.number().int().min(0).max(600),
  })
  .strict();
export type FactoryBatchSettings = z.infer<typeof factoryBatchSchema>;
export const DEFAULT_FACTORY_BATCH: FactoryBatchSettings = { size: 5, waitSeconds: 60 };

export type FactoryDependencies = 'wait' | 'stack';

/** A stacked run's blocker (D10): its run, its issue, its branch, and whether this run's PR was retargeted. */
export const factoryStackedOnSchema = z.object({
  runId: z.string(),
  issueNumber: z.number().int().positive(),
  branch: z.string(),
  /** The pull request now targets the default branch: the blocker landed. */
  retargeted: z.boolean().default(false),
});
export type FactoryStackedOn = z.infer<typeof factoryStackedOnSchema>;

/**
 * A member's approval to merge a high-risk change the factory held: for one
 * commit only, so a later push needs a new one.
 */
export const factoryMergeApprovalSchema = z.object({
  /** The head commit approved; the merge gate lets only this commit through. */
  sha: z.string().min(7),
  /** Who approved it. */
  userId: z.string(),
  at: z.string(),
});
export type FactoryMergeApproval = z.infer<typeof factoryMergeApprovalSchema>;

/** What the factory does with an issue triage finds too large for one change. */
export type FactoryTooBig = 'ask' | 'split';

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
    maxLowRiskLines: z
      .number()
      .int()
      .min(LOW_RISK_LINES_RANGE.min)
      .max(LOW_RISK_LINES_RANGE.max)
      .optional(),
    sizeIgnoredPaths: z
      .array(z.string().trim().min(1).max(200))
      .max(MAX_SIZE_IGNORED_PATHS)
      .optional(),
    stageLimits: z
      .record(z.string().min(1).max(64), z.number().int().min(1).max(20))
      .refine(
        (limits) => !(MERGE_STAGE in limits),
        'The merge limit cannot be changed: merges are one at a time per repository',
      )
      .optional(),
    /** Provider / model / effort per agent step id; never a permission mode or tool list. */
    stepOverrides: z.lazy(() => factoryStepOverridesSchema).optional(),
    batch: factoryBatchSchema.optional(),
    /** An issue whose blocker is in flight: wait for it, or start on its branch (D10). */
    dependencies: z.enum(['wait', 'stack']).optional(),
    /** An issue triage finds too large: propose the split on it, or open its parts as issues. */
    tooBig: z.enum(['ask', 'split']).optional(),
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
  /** A change with more counted lines than this is high risk. */
  maxLowRiskLines: number;
  /** Globs whose lines do not count toward a change's size, besides tests, Markdown and the like. */
  sizeIgnoredPaths: string[];
  /** Runs inside a flow node at once, per node id; replaces the flow's own limit. */
  stageLimits: Record<string, number>;
  /** Provider / model / effort per agent step id, over the flow's own (openspec factory-flow-step-options). */
  stepOverrides: FactoryStepOverrides;
  /** The merge queue's batch size and wait. */
  batch: FactoryBatchSettings;
  /** An issue whose blocker is in flight waits for it, or starts on its branch (openspec factory-integration D10). */
  dependencies: FactoryDependencies;
  /**
   * An issue triage finds too large: `ask` comments the proposed split and
   * waits for a person; `split` opens each part as an issue the factory admits.
   */
  tooBig: FactoryTooBig;
  /** Why the factory cannot make progress now (e.g. its runner is offline), or null. */
  blockedReason: string | null;
  /**
   * The incident that pauses the factory's admissions (its repository's base
   * branch is red after a factory merge), or null. Absent on answers that do
   * not look it up.
   */
  incident?: FactoryIncident | null;
  updatedAt: string;
}

export type FactoryRunState =
  /** Sent to the factory and waiting in its queue; holds no concurrency slot. */
  | 'requested'
  | 'queued'
  /** A read-only agent decides whether the issue can be worked unattended. */
  | 'triaging'
  /** Triage asked questions on the issue: parked, no slot, until the issue changes. */
  | 'needs_info'
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
  /**
   * Ended without a commit or a pull request because the agent found nothing
   * to change (and left no unsaved work behind). Not a failure: the issue goes
   * back to a person to close or reword. Retry starts a new agent.
   */
  | 'no_change'
  /**
   * A run without an issue whose flow finished without a pull request to
   * follow (change flow-triggers): a scheduled audit that ran and reported.
   */
  | 'done'
  | 'failed'
  | 'stopped';

export interface FactoryRun {
  id: string;
  factoryId: string;
  /** The run's issue; null for a run a schedule or a member started without one. */
  issueNumber: number | null;
  /** The name of the schedule trigger that started it, as it was then; null otherwise. */
  triggerName: string | null;
  /** The input values its trigger supplied; empty for an issue run. */
  inputs: Record<string, string>;
  prUrl: string | null;
  state: FactoryRunState;
  currentStep: string | null;
  threadIds: string[];
  /** When the row was written: the send time for a sent issue. */
  startedAt: string;
  /** When the run left the queue and its flow could start; null while `requested`. */
  admittedAt: string | null;
  completedAt: string | null;
  /** What started the run: a sent issue, a labelled issue, a schedule, or a member without an issue. */
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
  /** What triage decided about the issue, or null before it ran (and on older runs). */
  triage: FactoryTriage | null;
  /** The review verdicts of the run's pull request, one per commit, oldest first. */
  reviews: FactoryReviewVerdict[];
  /** The risk class of the pull request's last classified commit, or null before one. */
  risk: FactoryRisk | null;
  /** Where the run's flow came from; null on runs from before runs recorded it. */
  flowSource: FactoryFlowSource | null;
  /** The default-branch commit a repository flow was read at; null for a built-in. */
  flowCommit: string | null;
  /** The options each agent step ran with, in the order the steps started. */
  stepOptions: FactoryStepOptionsRecord[];
  /** A member's approval to merge its high-risk head commit, or null. */
  mergeApproval: FactoryMergeApproval | null;
  /**
   * Each execution of a node of the run's flow, in the order they started
   * (openspec factory-step-timings), from the workflow engine's journal.
   * Absent on answers that do not look it up (only the run lists do).
   */
  stepTimings?: FactoryStepTiming[];
}

/** One execution of a flow node of a run, as the run lists return it. */
export interface FactoryStepTiming {
  /** The flow node (`implement`, `review`, `merge`, …). */
  step: string;
  /** Which iteration of a loop this execution belongs to. */
  visit: string;
  /** 1 for the first try; higher after a retry or a resume. */
  attempt: number;
  status: FactoryStepTimingStatus;
  startedAt: string;
  /** Null while the execution runs. */
  finishedAt: string | null;
}

export type FactoryStepTimingStatus = 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

/** Where a run's flow came from (openspec factory-flow-step-options). */
export type FactoryFlowSource = 'repository' | 'built-in';

const effortLevel = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

/** The options one agent step of a run ran with, as the run stores them. */
export const factoryStepOptionsRecordSchema = z.object({
  /** `<node>`, or `<node>.before_retry` for a retry's fix step. */
  stepId: z.string(),
  threadId: z.string(),
  provider: z.string(),
  model: z.string(),
  /** Null: the provider's own default effort. */
  effort: effortLevel.nullable(),
  permissionMode: z.string(),
  allowedTools: z.array(z.string()).nullable(),
  disallowedTools: z.array(z.string()).nullable(),
  /** `new`: the step ran on a thread of its own instead of the implementing one. */
  thread: z.enum(['continue', 'new']),
});

export type FactoryStepOptionsRecord = z.infer<typeof factoryStepOptionsRecordSchema>;

/**
 * The run's implementing thread as it stands: the last thread a step of the
 * run continued, never one a `thread: new` step started (a read-only thread of
 * its own). What a member opens and follows up on to take the run over.
 */
export function implementingThreadOf(
  run: Pick<FactoryRun, 'threadIds' | 'stepOptions'>,
): string | undefined {
  const own = new Set(
    run.stepOptions.filter((step) => step.thread === 'new').map((step) => step.threadId),
  );
  for (let index = run.threadIds.length - 1; index >= 0; index -= 1) {
    const threadId = run.threadIds[index]!;
    if (!own.has(threadId)) return threadId;
  }
  return undefined;
}

/**
 * What a member may set for one agent step of their factory's flow: the
 * provider, model and effort, never the permission mode or tool lists (those
 * stay in the reviewed flow file). Strict, so a client cannot slip one in.
 */
export const factoryStepOverrideSchema = z
  .object({
    provider: z.string().trim().min(1).max(64).optional(),
    model: z.string().trim().min(1).max(200).optional(),
    effort: effortLevel.optional(),
  })
  .strict();

/** Overrides by step id (`<node>`, `<node>.before_retry`). */
export const factoryStepOverridesSchema = z
  .record(z.string().trim().min(1).max(128), factoryStepOverrideSchema)
  .refine((overrides) => Object.keys(overrides).length <= 50, 'At most 50 step overrides');

export type FactoryStepOverride = z.infer<typeof factoryStepOverrideSchema>;
export type FactoryStepOverrides = z.infer<typeof factoryStepOverridesSchema>;

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
   * The commit the tests ran on, when the proof holds for `headSha` because
   * `headSha` only brought the base branch into it (a merge lane update whose
   * checks passed). Absent on a proof that ran on `headSha` itself.
   */
  carriedFrom: z.string().optional(),
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
  /** `integrate` steps that had to merge the base in (not already up to date). */
  integrateRounds: number;
  /** Integrations whose conflicts were settled without an agent (merge driver, rerere, regenerator). */
  conflictsResolvedWithoutLlm: number;
  /** Integrations whose conflicts went to the implementing agent. */
  conflictsSentToAgent: number;
  /** Integrations where weave was the merge driver on the runner (the rest used git's own). */
  weaveIntegrations: number;
  /**
   * Merge rounds that reached the implementing agent (an integration conflict,
   * or checks failing on the current base); the run waits for a person after two.
   */
  mergeRoundsToAgent: number;
  /** Time spent in merge queue batches, in ms (openspec factory-integration D13). */
  queueWaitMs: number;
  /** The size of the last batch the run was merged or tested in (0: never batched). */
  batchSize: number;
  /** Halves its batches tested apart while bisecting. */
  bisectionRounds: number;
  /** Red batches it was in that turned green on the same tree. */
  ciFlakes: number;
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
  integrateRounds: 0,
  conflictsResolvedWithoutLlm: 0,
  conflictsSentToAgent: 0,
  weaveIntegrations: 0,
  mergeRoundsToAgent: 0,
  queueWaitMs: 0,
  batchSize: 0,
  bisectionRounds: 0,
  ciFlakes: 0,
};

export type FactoryRunSource = 'manual' | 'label' | 'schedule' | 'run_now';

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
    | 'proof-not-configured'
    /** Its likely paths overlap those of a run in progress (`blockers`: that run's issue). */
    | 'paths-overlap'
    /** Retried or approved while every slot was taken: first in line for the next one. */
    | 'no-free-slot';
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
  /**
   * True when the flow has a `review` step that resolves to the same provider
   * and model as its implementing agent (both left to the default count as the
   * same): the reviewer then tends to miss what the implementer missed. Absent
   * when the flow has no review step or cannot be parsed.
   */
  reviewerSameAsImplementer?: boolean;
}

/** Why a flow cannot run as a factory flow: the step and field the factory refused. */
export interface FactoryFlowProblem {
  /** The agent step (`<node>`, `<node>.before_retry`), `defaults`, or `flow` for a load error. */
  step: string;
  field: string;
  message: string;
}

/** One agent step of a validated flow, with the options a run would give it now. */
export interface FactoryFlowAgentStep {
  stepId: string;
  provider: string;
  model: string;
  effort: FactoryStepOptionsRecord['effort'];
  permissionMode: string;
  allowedTools: string[] | null;
  disallowedTools: string[] | null;
  /** `continue`: on the implementing thread; `new`: a read-only thread of its own. */
  thread: FactoryStepOptionsRecord['thread'];
  /** Whether a factory step override changed it. */
  overridden: boolean;
}

/**
 * Validate flow's answer (openspec factory-flow-step-options, D8): the flow as
 * an admitted run would load it now, or why it cannot run. Nothing is started.
 */
/**
 * How a repository's merges go through the factory's merge queue (openspec
 * factory-integration D12): in batches, one at a time (and why), or through
 * GitHub's own merge queue. Each reason says what to change.
 */
export interface FactoryReadiness {
  mode: 'batches' | 'serial' | 'host-queue';
  /** Whether CI runs on pushes to `factory/queue/**`; null when the workflows cannot be read. */
  queueCi: boolean | null;
  /** Whether the base branch requires GitHub's merge queue; null when unknown. */
  mergeQueueRequired: boolean | null;
  /** Whether pull requests must be up to date with the base; null when it cannot be read. */
  upToDateRequired: boolean | null;
  /**
   * The merge driver the enabler's runner used at the factory's last
   * integration: `weave` (structural) or `git` (git's own); null before one.
   */
  mergeDriver: 'weave' | 'git' | null;
  /** The median time CI took on the queue's branches (its last batches), in ms; null before one. */
  medianCiMs: number | null;
  /** How long the queue waits for a batch to fill, in ms. */
  batchWaitMs: number;
  /** Why it is not batching, each with what to change. */
  reasons: string[];
  /** What would make it merge faster or with fewer agent rounds; never blocks a batch. */
  advice: string[];
}

/** The issue opened to add the merge queue's CI trigger, and whether the factory queued it (D12). */
export interface FactoryQueueCiProposal {
  issueNumber: number;
  url: string;
  /** False when the issue was opened but the factory did not take it (the reason says why). */
  queued: boolean;
  reason?: string;
}

export type FactoryFlowValidation =
  | { ok: false; message: string; problems: FactoryFlowProblem[] }
  | {
      ok: true;
      name: string;
      source: FactoryFlowSource;
      /** The default-branch commit a repository flow was read at; null for a built-in. */
      commit: string | null;
      /** Every node in declaration order, by kind (`spawn_agent`, `wait_ci`, …). */
      steps: Array<{ id: string; kind: string }>;
      /** Every agent step, a retry's fix step included, with its resolved options. */
      agentSteps: FactoryFlowAgentStep[];
      /** Step overrides of the factory that name no agent step of this flow. */
      unusedOverrides: string[];
      /** Things that run but cost: a model change on a continuing thread replays its context. */
      warnings: string[];
    };

/**
 * Triggers (change flow-triggers): what starts a flow of the caller's factory
 * besides an issue. A schedule trigger starts its flow at each occurrence of a
 * cron pattern; its runs have no issue and get the trigger's input values.
 */

/** At most this many schedule triggers per factory. */
export const MAX_FACTORY_TRIGGERS = 20;

/** At most this many input values on a trigger or a "run a flow" start. */
export const MAX_TRIGGER_INPUTS = 20;

const triggerInputs = z
  .record(
    z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, {
      message: 'An input name is lowercase letters, digits and underscores, starting with a letter',
    }),
    z.string().max(4000),
  )
  .refine((inputs) => Object.keys(inputs).length <= MAX_TRIGGER_INPUTS, {
    message: `At most ${MAX_TRIGGER_INPUTS} inputs`,
  });

export interface FactoryTrigger {
  id: string;
  name: string;
  /** A cron pattern, in the server's time zone. */
  schedule: string;
  flowName: string;
  /** The input values each run gets. Shown to every member who sees the factory: no secrets. */
  inputs: Record<string, string>;
  enabled: boolean;
  /** The next occurrence; null while disabled. */
  nextRunAt: string | null;
}

/** Create a schedule trigger, or change the one with `id`. */
export const saveFactoryTriggerInput = z
  .object({
    projectId,
    id: z.string().min(1).optional(),
    name: z.string().trim().min(1).max(80),
    schedule: z.string().trim().min(1).max(120),
    flowName,
    inputs: triggerInputs.default({}),
    enabled: z.boolean().default(true),
  })
  .strict();

export type SaveFactoryTriggerInput = z.input<typeof saveFactoryTriggerInput>;

export const factoryTriggerInput = z.object({ projectId, triggerId: z.string().min(1) }).strict();

/** Start one run of a flow now, without an issue, with typed input values. */
export const runFactoryFlowInput = z
  .object({ projectId, flowName, inputs: triggerInputs.default({}) })
  .strict();

export type RunFactoryFlowInput = z.input<typeof runFactoryFlowInput>;

/** One input a flow declares and the factory does not supply itself. */
export interface FactoryFlowInput {
  name: string;
  required: boolean;
  description: string | null;
}

/**
 * Whether a flow can run without an issue, and what a member has to type to
 * start it: the "Run a flow" dialog and the trigger form read this.
 */
export interface FactoryIssuelessFlow {
  /** The inputs the flow declares and the factory does not supply itself. */
  inputs: FactoryFlowInput[];
  /** Why it cannot run without an issue (a step that needs one); empty when it can. */
  problems: FactoryFlowProblem[];
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
  /** Lines the change adds and removes (the merge queue's order, openspec factory-integration D11). */
  changedLines: z.number().int().nonnegative().optional(),
  /** The paths it changes, at most 300 (batches prefer members with disjoint paths, D11). */
  paths: z.array(z.string()).max(300).optional(),
});
export type FactoryRisk = z.infer<typeof factoryRiskSchema>;

/**
 * Triage (change factory-agent-roles, D4): a read-only agent reads the issue
 * and answers whether it can be worked unattended. `ready` carries the run's
 * contract; the other answers carry what to ask on the issue.
 */
const contractLine = z.string().trim().min(1).max(500);

/** What the run must do, written by triage and read by the implementer and the reviewer. */
export const factoryContractSchema = z.object({
  /** What must be true for the issue to be done. */
  acceptanceCriteria: z.array(contractLine).min(1).max(20),
  /** Globs of the files the change will probably touch (a prediction). */
  likelyPaths: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  /** Why the change may be risky; any hint makes it high risk. */
  riskHints: z.array(contractLine).max(10).default([]),
});
export type FactoryContract = z.infer<typeof factoryContractSchema>;

/** At most this many questions (or parts) go on the issue, each this long. */
export const MAX_TRIAGE_ITEMS = 5;
export const MAX_TRIAGE_ITEM_CHARS = 300;

const triageItems = z.array(z.string().trim().min(1).max(2000)).min(1).max(20);

export const factoryTriageResultSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('ready'), contract: factoryContractSchema }),
  z.object({ decision: z.literal('needs_info'), questions: triageItems }),
  z.object({ decision: z.literal('too_big'), parts: triageItems }),
]);
export type FactoryTriageResult = z.infer<typeof factoryTriageResultSchema>;

/**
 * What the run stores of its triage. `none`: triage gave no valid result
 * twice, and the run went on without a contract.
 */
export const factoryTriageSchema = z.object({
  decision: z.enum(['ready', 'needs_info', 'too_big', 'none']),
  /** When triage answered; an issue changed after it is triaged again. */
  at: z.string(),
  /** The triage agent's thread. */
  threadId: z.string().optional(),
  /** The contract, for `ready`. */
  contract: factoryContractSchema.optional(),
  /** What was asked on the issue (`needs_info`) or the proposed split (`too_big`). */
  items: z.array(z.string()).optional(),
  /**
   * The issue changed since (or a member retried): this answer is kept to show
   * what was asked, and triage runs again on a new thread, not `threadId`.
   */
  superseded: z.boolean().optional(),
  /**
   * For `too_big` with the factory's `split` setting: the issues opened for
   * the parts, in the order of `items` (filled as each one is opened).
   */
  splitInto: z.array(z.number().int().positive()).optional(),
});
export type FactoryTriage = z.infer<typeof factoryTriageSchema>;

/** The run's contract, when triage wrote one. */
export const contractOf = (run: { triage: FactoryTriage | null }): FactoryContract | null =>
  run.triage?.decision === 'ready' ? (run.triage.contract ?? null) : null;

/**
 * The sentinel (change factory-agent-roles, D10): a read-only agent that looks
 * at a base branch gone red after factory merges and names the merge that
 * broke it, or says it cannot.
 */
export const factorySentinelResultSchema = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('revert'),
    /** The number of the pull request whose merge broke the base branch. */
    culprit: z.number().int().positive(),
    reason: z.string().trim().min(1).max(2000),
  }),
  z.object({
    /**
     * `escalate`: a person must look; `unknown`: no merge can be named;
     * `unrelated`: the failure comes from a change that is none of the
     * factory's merges, so the incident closes and the factory goes on.
     */
    decision: z.enum(['escalate', 'unknown', 'unrelated']),
    reason: z.string().trim().min(1).max(2000),
  }),
]);
export type FactorySentinelResult = z.infer<typeof factorySentinelResultSchema>;

/** A factory merge the sentinel may name. */
export const factoryIncidentCandidateSchema = z.object({
  issueNumber: z.number().int(),
  prUrl: z.string(),
  mergedAt: z.string(),
  /** The run's enabler: who is told. */
  userId: z.string(),
  /** The commit the merge made on the base branch, when GitHub said (absent on older incidents). */
  mergeSha: z.string().optional(),
});
export type FactoryIncidentCandidate = z.infer<typeof factoryIncidentCandidateSchema>;

/** What an incident ended up with. */
export const factoryIncidentResultSchema = z.object({
  decision: z.enum(['revert', 'escalate', 'unknown', 'unrelated']),
  reason: z.string(),
  /** The pull request named as the cause (`revert`). */
  culpritPrUrl: z.string().optional(),
  /** The pull request that reverts it, when GitHub could open one. */
  revertPrUrl: z.string().optional(),
});
export type FactoryIncidentResult = z.infer<typeof factoryIncidentResultSchema>;

export type FactoryIncidentState = 'open' | 'investigating' | 'reported' | 'closed';

/** A base branch that turned red after a factory merge: admissions are paused on the repository. */
export interface FactoryIncident {
  id: string;
  /** `owner/name`. */
  repo: string;
  baseBranch: string;
  state: FactoryIncidentState;
  /** The red commit of the base branch. */
  redSha: string;
  openedAt: string;
  closedAt: string | null;
  candidates: FactoryIncidentCandidate[];
  result: FactoryIncidentResult | null;
}
