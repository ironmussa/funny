/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: yaml-loader, RuntimeActionProvider, agent-registry
 *
 * Production adapters that plug `SchedulerPipelineDispatcher` (from
 * `@funny/scheduler`) into the rest of the runtime:
 *
 *   - `YamlPipelineLoader`        wraps `loadPipelines()` so the dispatcher
 *                                 can resolve a YAML pipeline by name. Each
 *                                 dispatch reads from disk; the file set is
 *                                 small (built-ins + a couple of user
 *                                 overrides) and re-loading keeps the
 *                                 user-edit feedback loop trivial.
 *   - `RuntimeActionProviderFactory` builds a per-dispatch
 *                                 `RuntimeActionProvider` so the YAML
 *                                 actions (`spawn_agent`, `git_commit`,
 *                                 `notify`, …) are bound to the live
 *                                 runtime services for the calling thread.
 *   - `YamlContextBuilder`        adapts the factory to the
 *                                 `ContextBuilder<YamlPipelineContext>`
 *                                 contract the dispatcher consumes.
 *
 * These implementations are tiny on purpose: the dispatcher's contracts
 * (`PipelineLoader` / `ContextBuilder`) are the seam — production code
 * wires these, tests pass fakes.
 */

import type { PipelineDefinition, ProgressReporter } from '@funny/pipelines';
import type {
  ContextBuildMeta,
  ContextBuilder,
  DispatchInput,
  PipelineLoader,
  PipelineLoaderScope,
} from '@funny/thread-scheduler';
import { Result, ok, err } from 'neverthrow';

import { log } from '../lib/logger.js';
import type { ActionProvider } from '../pipelines/types.js';
import type { YamlPipelineContext } from '../pipelines/yaml-compiler.js';
import { loadPipelines } from '../pipelines/yaml-loader.js';
import { resolveBuiltinAgentByName } from './agent-registry.js';
import { RuntimeActionProvider, RuntimeProgressReporter } from './pipeline-adapter.js';

const NS = 'scheduler-pipeline-adapters';

// ── PipelineLoader ───────────────────────────────────────────

export class YamlPipelineLoader implements PipelineLoader<YamlPipelineContext> {
  async load(name: string, scope: PipelineLoaderScope) {
    const result = await loadPipelines({
      repoRoot: scope.cwd,
      resolveAgent: (agentName) => resolveBuiltinAgentByName(agentName),
    });

    if (result.warnings.length > 0) {
      log.warn('Scheduler pipeline loader: non-fatal warnings', {
        namespace: NS,
        warnings: result.warnings,
        projectId: scope.projectId,
        userId: scope.userId,
      });
    }

    const found = result.pipelines.get(name);
    return found
      ? {
          definition: found.definition,
          inputs: found.parsed.inputs,
        }
      : null;
  }
}

// ── ActionProviderFactory ────────────────────────────────────
//
// Kept as a stand-alone type so unit tests can drive the factory without
// going through the full ContextBuilder seam. Production wiring uses
// `YamlContextBuilder` (below), which delegates to this factory.

export interface ActionProviderFactory {
  build(input: DispatchInput): ActionProvider;
}

export class RuntimeActionProviderFactory implements ActionProviderFactory {
  build(input: DispatchInput): ActionProvider {
    return new RuntimeActionProvider({
      threadId: input.threadId,
      projectId: input.projectId,
      userId: input.userId,
    });
  }
}

// ── ContextBuilder ───────────────────────────────────────────
//
// Bridges the runtime's factory + YAML context shape to the generic
// `ContextBuilder<C>` contract the dispatcher in @funny/scheduler
// expects.

export class YamlContextBuilder implements ContextBuilder<YamlPipelineContext> {
  constructor(private readonly factory: ActionProviderFactory) {}

  build(
    input: DispatchInput,
    progress: ProgressReporter,
    meta?: ContextBuildMeta,
  ): YamlPipelineContext {
    return {
      provider: this.factory.build(input),
      progress: meta
        ? new MultiplexProgressReporter([
            progress,
            new RuntimeProgressReporter({
              userId: input.userId,
              threadId: input.threadId,
              runId: meta.pipelineRunId,
              workflowName: meta.pipelineName,
            }),
          ])
        : progress,
      cwd: input.cwd,
      inputs: input.inputs ?? { prompt: input.prompt, threadId: input.threadId },
      outputs: {},
    };
  }
}

class MultiplexProgressReporter implements ProgressReporter {
  constructor(private readonly reporters: ProgressReporter[]) {}

  onStepProgress(stepId: string, data: Parameters<ProgressReporter['onStepProgress']>[1]): void {
    for (const reporter of this.reporters) reporter.onStepProgress(stepId, data);
  }

  onPipelineEvent(event: string, data: Record<string, unknown>): void {
    for (const reporter of this.reporters) reporter.onPipelineEvent(event, data);
  }
}

// ── Result-flavored helpers (for callers in `result-response` paths) ──
//
// The class API throws on programmer errors (bad config), but most
// scheduler call sites prefer Result. These small wrappers keep the
// neverthrow boundary at the service layer per CLAUDE.md.

export async function loadSchedulerPipeline(
  name: string,
  scope: PipelineLoaderScope,
): Promise<Result<PipelineDefinition<YamlPipelineContext>, string>> {
  const loader = new YamlPipelineLoader();
  const loaded = await loader.load(name, scope);
  if (!loaded) return err(`pipeline "${name}" not found`);
  return ok(loaded.definition);
}
