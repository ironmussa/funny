/**
 * Action provider contract for compiled workflows.
 *
 * Defines the ActionProvider contract (with agent, git, and command
 * actions) and all related option types. These are domain concepts
 * that extend the generic @funny/pipelines engine.
 */

import type { NodeRunInfo, ProgressReporter } from '@funny/pipelines';

/**
 * The engine execution an action runs in: its loop visit, what was recorded
 * when the run resumes an unfinished execution (`resume`), `checkpoint` to
 * record work in progress (the thread an agent step started), and the
 * batch when the node leads one. Set when the action runs in a compiled
 * workflow.
 */
export type ActionExecution = NodeRunInfo;
import type { AgentDefinition, EffortLevel, PermissionMode } from '@funny/shared';
import type { JsonObject } from '@funny/shared/json';

// ── Action results ──────────────────────────────────────────

/** The result of any pipeline action. */
export interface ActionResult {
  ok: boolean;
  /** Stdout or agent output on success. */
  output?: string;
  /** Error message on failure. */
  error?: string;
  /** Arbitrary metadata from the action. */
  metadata?: JsonObject;
}

// ── Action option types ─────────────────────────────────────

export interface SpawnAgentOpts {
  /** Prompt to send to the agent. */
  prompt: string;
  /** Working directory for the agent. */
  cwd: string;
  /**
   * The step this spawn is: the node id, `<node>.before_retry` for a retry's
   * fixer agent. The same for every attempt, so a host can key per-step
   * settings on it.
   */
  stepId?: string;
  /** Agent permission mode, as the flow wrote it (the host decides what it allows). */
  mode?: PermissionMode;
  /** Reasoning effort for this step. */
  effort?: EffortLevel;
  /**
   * `continue` (default): the host may run the step on a thread an earlier
   * agent step started. `new`: the step asks for its own thread.
   */
  thread?: 'continue' | 'new';
  /** The flow's `defaults:` block, for the host to apply under the step's own options. */
  defaults?: SpawnAgentDefaults;
  /** Model to use (e.g. 'sonnet', 'opus', 'haiku'). */
  model?: string;
  /**
   * Provider to use (e.g. 'claude', 'codex', 'gemini'). Takes precedence
   * over `agent.provider`. Enables heterogeneous panels (Mixture-of-Agents),
   * where each node targets a different model family.
   */
  provider?: string;
  /** Extra context from a previous step. */
  context?: string;
  /**
   * Agent definition — if provided, model, mode, allowedTools, and
   * disallowedTools default to the agent's values when not overridden
   * explicitly on these opts.
   */
  agent?: AgentDefinition;
  /**
   * Tools allow-list for this spawn. Falls back to `agent.allowedTools`.
   * If both are unset, no allow-list is applied (the agent runs with the
   * default tool surface for its permission mode).
   */
  allowedTools?: string[];
  /**
   * Tools deny-list for this spawn. Falls back to `agent.disallowedTools`.
   */
  disallowedTools?: string[];
  /** The execution this spawn belongs to: adopt `resume.recorded` work, `checkpoint` new work. */
  execution?: ActionExecution;
}

/** A flow's `defaults:` block: options every agent step gets unless it sets its own. */
export interface SpawnAgentDefaults {
  provider?: string;
  model?: string;
  effort?: EffortLevel;
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
}

export interface RunCommandOpts {
  /** Shell command to execute. */
  command: string;
  /** Working directory. */
  cwd: string;
  /** Timeout in milliseconds. */
  timeout?: number;
}

export interface GitCommitOpts {
  cwd: string;
  message: string;
  /** Specific files to stage before committing. Empty = commit staged. */
  files?: string[];
  /** Amend the previous commit. */
  amend?: boolean;
  /** Skip pre-commit hooks (--no-verify). */
  noVerify?: boolean;
}

export interface GitPushOpts {
  cwd: string;
  branch?: string;
  force?: boolean;
  /** Set upstream tracking. */
  setUpstream?: boolean;
}

export interface CreatePrOpts {
  cwd: string;
  title: string;
  body?: string;
  base?: string;
  draft?: boolean;
}

export interface NotifyOpts {
  message: string;
  level?: 'info' | 'warning' | 'error';
}

// ── Thread lifecycle action options ─────────────────────────
//
// These are typed as plain strings here (not the ThreadStatus /
// ThreadStage unions) so this types module stays free of a
// `@funny/shared` import; the runtime provider validates the
// string against the canonical enum at dispatch time.

export interface SetStatusOpts {
  /** Thread id whose status should change. */
  threadId: string;
  /** New ThreadStatus value (validated by the provider). */
  value: string;
  /** Optional reason — surfaced in the WS event payload. */
  reason?: string;
}

export interface SetStageOpts {
  /** Thread id whose stage should change. */
  threadId: string;
  /** New ThreadStage value (validated by the provider). */
  value: string;
  /** Optional reason — surfaced in the WS event payload. */
  reason?: string;
}

// ── GitHub integration action options ───────────────────────
//
// Run-implicit, like SetStatusOpts: the provider binds these to the run's
// pull request, so the options carry only the knobs. The factory's
// server-side provider does the GitHub work under a repo-scoped token.

export interface RegressionProofOpts {
  rules: Array<{ globs: string[]; command: string; cwd?: string }>;
  supportGlobs?: string[];
  requireTest?: 'always' | 'labels' | 'never';
  labels?: string[];
  /** Labels whose issues need no test, whatever `requireTest` says. */
  exemptLabels?: string[];
  /** Run in each temporary checkout before the tests. */
  setupCommand?: string;
  timeoutMs?: number;
}

export interface WaitCiOpts {
  /** Overall budget before the step returns a timeout verdict. */
  timeoutMs?: number;
  /** Poll cadence while checks are pending. */
  intervalMs?: number;
  /** Subset of check names that must pass; default is all required checks. */
  requiredChecks?: string[];
  /**
   * The flow's `review` step configuration, when it has one that starts early
   * (`early` is not false): the provider may start reviewing the commit while
   * its checks run.
   */
  earlyReview?: ReviewOpts;
}

export interface MergeOpts {
  /** Merge strategy; default decided by the provider / repository. */
  method?: 'merge' | 'squash' | 'rebase';
  /** Delete the head branch after a successful merge. */
  deleteBranch?: boolean;
  /** Enable auto-merge instead of merging directly. */
  auto?: boolean;
  /** The execution this merge belongs to; `execution.batch` is set when it leads a batch. */
  execution?: ActionExecution;
  /**
   * Whether the merge needs a regression proof of the head it merges (the
   * step's `require_regression_proof`, default true).
   */
  requireRegressionProof?: boolean;
  /** The flow's `regression_proof` step configuration, when it has one. */
  regressionProof?: RegressionProofOpts;
  /**
   * Whether the merge needs a passing verdict of the flow's `review` step for
   * the head it merges (the step's `require_review`, default true).
   */
  requireReview?: boolean;
  /**
   * The node that produces the change (`regenerate`): a conflict goes back to
   * it, and the run is merged alone.
   */
  regenerate?: string;
}

/** A `triage` step: whether the run's issue can be worked unattended, and its contract. */
export interface TriageOpts {
  provider?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** The execution this triage belongs to. */
  execution?: ActionExecution;
}

/** Options of an `integrate` step: the host reads what it may run from its own configuration. */
export interface IntegrateOpts {
  /** The execution this step belongs to (a resumed run adopts its recorded work). */
  execution?: ActionExecution;
}

/**
 * A `review` step: an independent verdict on the run's pull request head. The
 * provider owns the reviewer's thread, permissions, inputs and result format.
 */
export interface ReviewOpts {
  provider?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Start when the commit's checks start (default true). */
  early?: boolean;
  /** The execution this review belongs to: adopt `resume.recorded` work, `checkpoint` new work. */
  execution?: ActionExecution;
}

// ── Approval (human-in-the-loop) ────────────────────────────
//
// Modeled to match Archon's `approval:` node semantics so workflows can be
// migrated/round-tripped without redesigning the data model:
//   - `message` corresponds to Archon's `message` field
//   - `captureResponse` corresponds to Archon's `capture_response`
//   - rejection reasons are passed via the decision payload (Archon's
//     `$REJECTION_REASON` template variable)
//
// Reference: https://github.com/coleam00/Archon — `.archon/workflows/defaults/`

export interface RequestApprovalOpts {
  /**
   * Stable id for this approval gate within a pipeline run. Used by the UI
   * and the response-handler to route the approval back to the correct
   * pending promise.
   */
  gateId: string;
  /** User-facing message shown in the approval UI. */
  message: string;
  /**
   * If true, the approver may attach a free-text comment that gets returned
   * in the decision payload. Default: false.
   */
  captureResponse?: boolean;
  /**
   * Optional timeout (ms). If reached, the returned promise rejects with
   * an `ApprovalTimeoutError`. Default: no timeout (waits indefinitely).
   */
  timeoutMs?: number;
}

export type ApprovalDecision =
  | { decision: 'approve'; comment?: string }
  | { decision: 'reject'; reason: string };

// ── ActionProvider interface ────────────────────────────────

/**
 * The ActionProvider is the bridge between a pipeline and the outside world.
 *
 * Each consumer (Funny runtime, a CLI, tests) provides *how* the actions
 * work by implementing this interface.
 */
export interface ActionProvider {
  /** Spawn an AI agent and wait for it to complete. */
  spawnAgent(opts: SpawnAgentOpts): Promise<ActionResult>;

  /** Execute a shell command. */
  runCommand(opts: RunCommandOpts): Promise<ActionResult>;

  /** Stage files and create a git commit. */
  gitCommit(opts: GitCommitOpts): Promise<ActionResult>;

  /** Push to remote. */
  gitPush(opts: GitPushOpts): Promise<ActionResult>;

  /** Create a pull request. */
  createPr(opts: CreatePrOpts): Promise<ActionResult>;

  /** Send a notification / status message. */
  notify(opts: NotifyOpts): Promise<ActionResult>;

  /** Update a thread's status. Validates `value` against ThreadStatus. */
  setStatus(opts: SetStatusOpts): Promise<ActionResult>;

  /** Update a thread's stage. Validates `value` against ThreadStage. */
  setStage(opts: SetStageOpts): Promise<ActionResult>;

  /**
   * Wait for the run's pull-request checks to reach a terminal verdict.
   * Resolves `ok: true` when required checks pass (green); `ok: false` with a
   * timeout or the failing check names (in `error` and `metadata.failingChecks`)
   * when red or timed out, so the flow's retry can act on it.
   */
  waitCi(opts: WaitCiOpts): Promise<ActionResult>;

  /**
   * Merge the run's pull request (or enable auto-merge). Only merges when the
   * PR's required checks are green; otherwise resolves `ok: false`.
   */
  merge(opts: MergeOpts): Promise<ActionResult>;

  /**
   * Run a regression proof: test the changed files against the base (must
   * fail) and the head (must pass). The provider starts and polls the job.
   */
  regressionProof?(opts: RegressionProofOpts): Promise<ActionResult>;

  /**
   * Triage the run's issue on a read-only agent. Resolves `ok: true` when the
   * run may go on, with `metadata.contract` (text for the implementing agent,
   * empty without a contract); `ok: false` when the run stops here (questions
   * were asked on the issue, or it waits for other work on the same files).
   */
  triage?(opts: TriageOpts): Promise<ActionResult>;

  /**
   * Review the run's pull request head on an independent read-only agent.
   * Resolves `ok: true` with the verdict in `metadata` (`verdict`,
   * `allowsMerge`, `sha`, `feedback`) whether it passes or fails, so a loop
   * can send the findings back; `ok: false` when no verdict could be had.
   */
  review?(opts: ReviewOpts): Promise<ActionResult>;

  /**
   * Merge the base branch into the run's branch without an agent. Resolves
   * `ok: true` with `metadata.outcome` (`up-to-date`, `merged`, `conflict`)
   * so a loop can send a conflict on; `ok: false` when git or a regenerator
   * could not run.
   */
  integrate?(opts: IntegrateOpts): Promise<ActionResult>;

  /**
   * Request a human approval and block until decided (or timeout).
   * Throws `ApprovalTimeoutError` on timeout. Resolves to an
   * `ApprovalDecision` describing approve/reject + optional payload.
   */
  requestApproval(opts: RequestApprovalOpts): Promise<ApprovalDecision>;
}

// ── Pipeline context ────────────────────────────────────────

/**
 * Base context that every domain pipeline receives.
 * Pipeline definitions extend this with their own fields.
 */
export interface PipelineContext {
  /** The ActionProvider to use for all actions. */
  provider: ActionProvider;
  /** Progress reporter for step-level and pipeline-level updates. */
  progress: ProgressReporter;
  /** Working directory. */
  cwd: string;
}
