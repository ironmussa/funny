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
export { definePipeline, node, subPipeline, compose, runPipeline } from './engine.js';

export type {
  NodeFn,
  GuardFn,
  PipelineNode,
  PipelineLoop,
  PipelineDefinition,
  PipelineStateKind,
  PipelineStateChange,
  OnStateChange,
  PipelineRunOptions,
  PipelineOutcome,
  PipelineRunResult,
} from './engine.js';

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
