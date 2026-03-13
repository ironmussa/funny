/**
 * Domain-specific pipeline definitions for the Funny runtime.
 *
 * These pipelines use the generic @funny/pipelines engine but define
 * domain concepts (agents, git, commands) via the ActionProvider interface.
 */

// ── Domain types ────────────────────────────────────────────
export type {
  ActionResult,
  ActionProvider,
  SpawnAgentOpts,
  RunCommandOpts,
  GitCommitOpts,
  GitPushOpts,
  CreatePrOpts,
  NotifyOpts,
  PipelineContext,
} from './types.js';

// ── Runner ──────────────────────────────────────────────────
export { PipelineRunner } from './runner.js';
export type { RunnerOptions } from './runner.js';

// ── Pipeline definitions ────────────────────────────────────
export { commitPipeline } from './commit.pipeline.js';
export type { CommitPipelineContext } from './commit.pipeline.js';

export { codeReviewPipeline, parseReviewOutput } from './code-review.pipeline.js';
export type { CodeReviewPipelineContext } from './code-review.pipeline.js';

export { prePushPipeline } from './pre-push.pipeline.js';
export type { PrePushPipelineContext } from './pre-push.pipeline.js';

export { codeQualityPipeline } from './code-quality.pipeline.js';
export type { CodeQualityContext } from './code-quality.pipeline.js';
