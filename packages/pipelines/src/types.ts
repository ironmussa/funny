/**
 * @funny/pipelines — Core types.
 *
 * Generic pipeline types. This package knows NOTHING about agents,
 * git, commands, or any specific domain.  It only defines the
 * shape of progress reporting and step-level error configuration.
 *
 * Domain-specific contracts (ActionProvider, git opts, etc.) belong
 * in the consumer package (e.g. @funny/runtime).
 */

// ── Progress reporting ────────────────────────────────────────

/** Status of a pipeline step. */
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/** A sub-item within a step (e.g. individual hooks). */
export interface StepSubItem {
  label: string;
  status: StepStatus;
  error?: string;
}

/** Data payload for step progress updates. */
export interface StepProgressData {
  status: StepStatus;
  error?: string;
  /** Sub-items for composite steps (e.g. multiple hooks). */
  subItems?: StepSubItem[];
  /** Extra metadata (e.g. PR url, iteration count). */
  metadata?: Record<string, unknown>;
}

/**
 * The ProgressReporter is the bridge for pipeline → UI communication.
 *
 * Pipelines call these methods to report progress. The consumer (Funny
 * runtime, CLI, tests) implements *how* to display/persist the progress.
 *
 * This keeps the pipeline package completely decoupled from any specific
 * messaging infrastructure (WebSockets, DB persistence, etc.).
 */
export interface ProgressReporter {
  /** Report that a step's status changed. */
  onStepProgress(stepId: string, data: StepProgressData): void;
  /** Report a pipeline-level event (started, completed, failed, etc.). */
  onPipelineEvent(event: string, data: Record<string, unknown>): void;
}

/**
 * A no-op progress reporter for contexts where progress reporting isn't needed.
 */
export const nullReporter: ProgressReporter = {
  onStepProgress: () => {},
  onPipelineEvent: () => {},
};

// ── Step-level config ───────────────────────────────────────

export type OnErrorStrategy = 'fail' | 'retry' | 'skip';

/** Per-step retry/error configuration. */
export interface StepErrorConfig {
  /** What to do when this step fails. Default: 'fail'. */
  strategy: OnErrorStrategy;
  /** Max retries (only applies when strategy is 'retry'). Default: 3. */
  maxRetries?: number;
  /**
   * Optional recovery function that runs before each retry.
   * Receives the error and can modify context before retry.
   */
  recover?: (error: string, ctx: unknown) => Promise<unknown>;
}
