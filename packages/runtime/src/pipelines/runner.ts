/**
 * PipelineRunner — high-level API to execute pipeline definitions.
 *
 * Wraps the generic pipeline engine from @funny/pipelines with
 * ActionProvider-aware context and notification logic.
 */

import {
  runPipeline,
  nullReporter,
  type PipelineDefinition,
  type PipelineRunOptions,
  type PipelineRunResult,
  type OnStateChange,
  type ProgressReporter,
} from '@funny/pipelines';

import type { ActionProvider, PipelineContext } from './types.js';

// ── Runner options ──────────────────────────────────────────

export interface RunnerOptions<T> {
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
  /** Callback for pipeline state changes. */
  onStateChange?: OnStateChange<T>;
  /** Override max loop iterations. */
  maxIterations?: number;
}

// ── PipelineRunner ──────────────────────────────────────────

export class PipelineRunner {
  private provider: ActionProvider;

  constructor(provider: ActionProvider) {
    this.provider = provider;
  }

  /**
   * Execute a pipeline definition.
   *
   * The runner injects the ActionProvider into the initial context
   * and delegates to the shared pipeline-engine.
   */
  async run<T extends PipelineContext>(
    pipeline: PipelineDefinition<T>,
    initialCtx: Omit<T, 'provider' | 'progress'> & { progress?: ProgressReporter },
    opts?: RunnerOptions<T>,
  ): Promise<PipelineRunResult<T>> {
    const ctx = {
      ...initialCtx,
      provider: this.provider,
      progress: initialCtx.progress ?? nullReporter,
    } as T;

    const runOpts: PipelineRunOptions<T> = {
      signal: opts?.signal,
      onStateChange: opts?.onStateChange,
      maxIterations: opts?.maxIterations,
    };

    // Notify start
    await this.provider.notify({
      message: `Pipeline "${pipeline.name}" started`,
      level: 'info',
    });

    const result = await runPipeline(pipeline, ctx, runOpts);

    // Notify completion
    if (result.outcome === 'completed') {
      await this.provider.notify({
        message: `Pipeline "${pipeline.name}" completed (${result.iterations} iteration(s))`,
        level: 'info',
      });
    } else if (result.outcome === 'failed') {
      await this.provider.notify({
        message: `Pipeline "${pipeline.name}" failed: ${result.error}`,
        level: 'error',
      });
    } else if (result.outcome === 'cancelled') {
      await this.provider.notify({
        message: `Pipeline "${pipeline.name}" was cancelled`,
        level: 'warning',
      });
    }

    return result;
  }
}
