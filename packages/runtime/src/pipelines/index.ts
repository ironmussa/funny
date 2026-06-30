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
  RequestApprovalOpts,
  ApprovalDecision,
  PipelineContext,
} from './types.js';

// ── Approval node helper ────────────────────────────────────
export { approvalNode, ApprovalRejectedError, ApprovalTimeoutError } from './approval.js';
export type { ApprovalNodeOpts, ApprovalCapturedOutputs } from './approval.js';

// ── YAML compiler ───────────────────────────────────────────
export { compileYamlPipeline, YamlCompileError } from './yaml-compiler.js';
export type {
  YamlPipelineContext,
  NodeOutput,
  AgentResolver,
  CompileOptions,
} from './yaml-compiler.js';

// ── YAML loader ─────────────────────────────────────────────
export { loadPipelines, getPipelineByName } from './yaml-loader.js';
export type { LoadOptions, LoadedPipeline, LoadResult } from './yaml-loader.js';

// ── Runner ──────────────────────────────────────────────────
export { PipelineRunner } from './runner.js';
export type { RunnerOptions } from './runner.js';

// Pipeline definitions are no longer exported from here — they live as
// YAML files under `defaults/` and are loaded by `loadPipelines()`. To
// override a built-in, place a file at `<repoRoot>/.funny/workflows/<name>.yaml`.
