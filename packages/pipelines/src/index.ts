/**
 * @funny/pipelines — Generic pipeline engine.
 *
 * A domain-agnostic engine for executing pipelines as sequences of
 * named nodes with guards, loops, sub-pipelines, and composition.
 *
 * This package knows NOTHING about agents, git, commands, or any
 * specific domain. All domain logic (ActionProvider, pipeline
 * definitions, etc.) belongs in the consumer package.
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
export {
  definePipeline,
  node,
  subPipeline,
  compose,
  runPipeline,
  computeLevels,
} from './engine.js';

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
