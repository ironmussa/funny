import {
  definePipeline,
  node,
  runPipeline,
  nullReporter,
  type GuardFn,
  type NodeRetryConfig,
  type PipelineDefinition,
  type PipelineRunResult,
  type ProgressReporter,
} from '@funny/pipelines';

import type { HarnessAgentDefinition, HarnessAgentOptions } from './agent.js';
import { HarnessError } from './errors.js';
import type { HarnessRuntime } from './runtime.js';
import { createSession, type HarnessSession } from './session.js';
import { createToolRegistry, ToolRegistry } from './tools.js';

export interface HarnessWorkflowContext {
  cwd: string;
  runtime: HarnessRuntime;
  progress: ProgressReporter;
  tools: ToolRegistry;
  createSession: (
    agent: HarnessAgentDefinition | HarnessAgentOptions,
    options?: { sessionId?: string },
  ) => HarnessSession;
  [key: string]: unknown;
}

export type HarnessWorkflowStepFn<TCtx extends HarnessWorkflowContext> = (
  ctx: TCtx,
  signal: AbortSignal,
) => TCtx | Promise<TCtx>;

export interface HarnessWorkflowStep<TCtx extends HarnessWorkflowContext> {
  name: string;
  execute: HarnessWorkflowStepFn<TCtx>;
  when?: GuardFn<TCtx>;
  retry?: NodeRetryConfig<TCtx>;
  dependsOn?: string[];
}

export interface HarnessWorkflowDefinition<TCtx extends HarnessWorkflowContext> {
  readonly name: string;
  readonly steps: readonly HarnessWorkflowStep<TCtx>[];
  readonly pipeline: PipelineDefinition<TCtx>;
}

export interface DefineWorkflowOptions<TCtx extends HarnessWorkflowContext> {
  name: string;
  steps: readonly HarnessWorkflowStep<TCtx>[];
  loop?: PipelineDefinition<TCtx>['loop'];
  mergeContexts?: PipelineDefinition<TCtx>['mergeContexts'];
}

export interface RunWorkflowOptions<TCtx extends HarnessWorkflowContext> {
  cwd: string;
  runtime: HarnessRuntime;
  initialContext?: Partial<TCtx>;
  tools?: ToolRegistry;
  progress?: ProgressReporter;
  signal?: AbortSignal;
  maxIterations?: number;
}

export interface HarnessWorkflowResult<TCtx extends HarnessWorkflowContext> {
  outcome: PipelineRunResult<TCtx>['outcome'];
  ctx: TCtx;
  error?: string;
  iterations: number;
}

export function defineWorkflow<TCtx extends HarnessWorkflowContext>(
  options: DefineWorkflowOptions<TCtx>,
): HarnessWorkflowDefinition<TCtx> {
  if (!options.name?.trim()) {
    throw new HarnessError('invalid_runtime_request', 'Workflow name is required');
  }
  if (!options.steps.length) {
    throw new HarnessError('invalid_runtime_request', 'Workflow requires at least one step');
  }

  const pipeline = definePipeline<TCtx>({
    name: options.name,
    nodes: options.steps.map((stepDef) =>
      node(stepDef.name, stepDef.execute, {
        when: stepDef.when,
        retry: stepDef.retry,
        dependsOn: stepDef.dependsOn,
      }),
    ),
    loop: options.loop,
    mergeContexts: options.mergeContexts,
  });

  return Object.freeze({
    name: options.name,
    steps: Object.freeze([...options.steps]),
    pipeline,
  });
}

export async function runWorkflow<TCtx extends HarnessWorkflowContext>(
  workflow: HarnessWorkflowDefinition<TCtx>,
  options: RunWorkflowOptions<TCtx>,
): Promise<HarnessWorkflowResult<TCtx>> {
  if (!options.runtime) {
    throw new HarnessError('runtime_unavailable', 'Workflow runtime is required');
  }
  if (!options.cwd?.trim()) {
    throw new HarnessError('invalid_runtime_request', 'Workflow cwd is required');
  }

  const progress = options.progress ?? nullReporter;
  const tools = options.tools ?? createToolRegistry();
  const ctx = {
    ...(options.initialContext ?? {}),
    cwd: options.cwd,
    runtime: options.runtime,
    progress,
    tools,
    createSession: (agent: HarnessAgentDefinition | HarnessAgentOptions, sessionOptions = {}) =>
      createSession({
        agent,
        runtime: options.runtime,
        cwd: options.cwd,
        sessionId: sessionOptions.sessionId,
        toolRegistry: tools,
      }),
  } as TCtx;

  progress.onPipelineEvent('started', { workflowName: workflow.name });

  const result = await runPipeline(workflow.pipeline, ctx, {
    signal: options.signal,
    maxIterations: options.maxIterations,
    onStateChange: (change) => {
      if (change.kind === 'entering') {
        progress.onStepProgress(change.nodeName, { status: 'running' });
      } else if (change.kind === 'completed') {
        progress.onStepProgress(change.nodeName, { status: 'completed' });
      } else if (change.kind === 'skipped') {
        progress.onStepProgress(change.nodeName, { status: 'skipped' });
      } else if (change.kind === 'error') {
        progress.onStepProgress(change.nodeName, { status: 'failed', error: change.error });
      } else if (change.kind === 'terminal') {
        progress.onPipelineEvent(change.outcome ?? 'completed', {
          workflowName: workflow.name,
          nodeName: change.nodeName,
          error: change.error,
        });
      }
    },
  });

  if (result.outcome === 'completed') {
    progress.onPipelineEvent('completed', { workflowName: workflow.name });
  } else if (result.outcome === 'failed') {
    progress.onPipelineEvent('failed', { workflowName: workflow.name, error: result.error });
  } else {
    progress.onPipelineEvent('cancelled', { workflowName: workflow.name });
  }

  return {
    outcome: result.outcome,
    ctx: result.ctx,
    error: result.error,
    iterations: result.iterations,
  };
}
