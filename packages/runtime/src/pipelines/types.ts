/**
 * Domain-specific pipeline types for the Funny runtime.
 *
 * Defines the ActionProvider contract (with agent, git, and command
 * actions) and all related option types. These are domain concepts
 * that extend the generic @funny/pipelines engine.
 */

import type { ProgressReporter } from '@funny/pipelines';
import type { AgentDefinition } from '@funny/shared';

// ── Action results ──────────────────────────────────────────

/** The result of any pipeline action. */
export interface ActionResult {
  ok: boolean;
  /** Stdout or agent output on success. */
  output?: string;
  /** Error message on failure. */
  error?: string;
  /** Arbitrary metadata from the action. */
  metadata?: Record<string, unknown>;
}

// ── Action option types ─────────────────────────────────────

export interface SpawnAgentOpts {
  /** Prompt to send to the agent. */
  prompt: string;
  /** Working directory for the agent. */
  cwd: string;
  /** Agent permission mode. */
  mode?: 'plan' | 'autoEdit' | 'confirmEdit';
  /** Model to use (e.g. 'sonnet', 'opus', 'haiku'). */
  model?: string;
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
