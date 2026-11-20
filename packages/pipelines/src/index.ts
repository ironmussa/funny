/**
 * @funny/pipelines — Generic workflow engine.
 *
 * A domain-agnostic engine that runs a pipeline as a graph of named nodes:
 *
 * - `scheduler.ts`: one ready-queue executor for every shape. A node starts
 *   once its dependencies allow (`dependsOn`, `triggerRule`), up to
 *   `maxConcurrency` per run; a plain list is a chain. Loops repeat a region
 *   (`loop` on a node, nested or disjoint), failures cancel other branches
 *   unless `onError: 'continue'`, and cancellation waits for nodes to stop.
 * - `gate.ts`: the `ConcurrencyGate` port. Concurrency groups limit a node
 *   across runs, and batch groups run it once for several waiting runs.
 * - `journal.ts`: the `Journal` port. Executions are recorded, and a run
 *   that starts again replays them instead of repeating recorded work.
 * - `node-runner.ts`: one node execution (guard, slot, retries, abort).
 *
 * Hosts supply the ports (in-memory defaults here). This package knows
 * NOTHING about agents, git, commands, or any specific domain. All domain
 * logic (ActionProvider, pipeline definitions, etc.) belongs in the
 * consumer package.
 *
 * Usage:
 *   import { definePipeline, node, runPipeline } from '@funny/pipelines';
 *
 *   const pipeline = definePipeline<MyContext>({
 *     name: 'my-pipeline',
 *     nodes: [
 *       node('step-1', async (ctx) => ({ ...ctx, done: true })),
 *     ],
 *   });
 *
 *   const result = await runPipeline(pipeline, { done: false });
 */

// ── Engine primitives ───────────────────────────────────────
export { definePipeline, node, subPipeline, compose, runPipeline } from './engine.js';

export type {
  NodeFn,
  GuardFn,
  NodeRetryConfig,
  PipelineNode,
  TriggerRule,
  NodeOnError,
  NodeLoop,
  NodeRunInfo,
  NodeConcurrency,
  NodeBatch,
  PipelineLoop,
  PipelineDefinition,
  PipelineStateKind,
  PipelineStateChange,
  OnStateChange,
  PipelineRunOptions,
  PipelineOutcome,
  PipelineRunResult,
} from './engine.js';

// ── Concurrency groups ──────────────────────────────────────
export { createMemoryConcurrencyGate, defaultConcurrencyGate } from './gate.js';
export type {
  Batch,
  BatchMember,
  BatchPolicy,
  ConcurrencyGate,
  MemberOutcome,
  MemberState,
  MemoryGateOptions,
  SettledOutcome,
  SlotGrant,
  SlotRelease,
  SlotRequest,
} from './gate.js';

// ── Execution journal ───────────────────────────────────────
export { createMemoryJournal } from './journal.js';
export type { ExecutionStatus, Journal, JournalEntry, ResumeInfo } from './journal.js';

// ── Progress reporting types ────────────────────────────────
export type {
  StepStatus,
  StepSubItem,
  StepProgressData,
  ProgressReporter,
  StepErrorConfig,
  OnErrorStrategy,
} from './types.js';
export { nullReporter } from './types.js';

// ── Templating and predicates ───────────────────────────────
//
// The Funny-specific workflow YAML schema/parser lives in @funny/workflows.
// The engine keeps only reusable expression helpers here.

export {
  interpolate,
  interpolateObject,
  TemplateInterpolationError,
  type TemplateScope,
  type InterpolateOptions,
} from './yaml/interpolate.js';

export {
  compilePredicate,
  evaluatePredicate,
  PredicateError,
  type CompiledPredicate,
} from './yaml/predicates.js';
