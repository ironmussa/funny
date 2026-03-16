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
  /** Agent definition — if provided, model and mode default to agent's values. */
  agent?: AgentDefinition;
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
