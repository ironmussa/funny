/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: yaml-loader, RuntimeActionProvider, agent-registry
 *
 * Production adapters that plug `OrchestratorPipelineDispatcher` (from
 * `@funny/orchestrator`) into the rest of the runtime:
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

import type { ProgressReporter } from '@funny/pipelines';
import type {
  ContextBuilder,
  DispatchInput,
  PipelineLoader,
  PipelineLoaderScope,
} from '@funny/thread-orchestrator';
import { Result, ok, err } from 'neverthrow';

import { log } from '../lib/logger.js';
import type { ActionProvider } from '../pipelines/types.js';
import type { YamlPipelineContext } from '../pipelines/yaml-compiler.js';
import { loadPipelines } from '../pipelines/yaml-loader.js';
import { resolveBuiltinAgentByName } from './agent-registry.js';
import { RuntimeActionProvider } from './pipeline-adapter.js';

const NS = 'orchestrator-pipeline-adapters';

// ── PipelineLoader ───────────────────────────────────────────

export class YamlPipelineLoader implements PipelineLoader<YamlPipelineContext> {
  async load(name: string, scope: PipelineLoaderScope) {
    const result = await loadPipelines({
      repoRoot: scope.cwd,
      resolveAgent: (agentName) => resolveBuiltinAgentByName(agentName),
    });

    if (result.warnings.length > 0) {
      log.warn('Orchestrator pipeline loader: non-fatal warnings', {
        namespace: NS,
        warnings: result.warnings,
        projectId: scope.projectId,
        userId: scope.userId,
      });
    }

    const found = result.pipelines.get(name);
    return found?.definition ?? null;
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
// `ContextBuilder<C>` contract the dispatcher in @funny/orchestrator
// expects.

export class YamlContextBuilder implements ContextBuilder<YamlPipelineContext> {
  constructor(private readonly factory: ActionProviderFactory) {}

  build(input: DispatchInput, progress: ProgressReporter): YamlPipelineContext {
    return {
      provider: this.factory.build(input),
      progress,
      cwd: input.cwd,
      inputs: { prompt: input.prompt, threadId: input.threadId },
      outputs: {},
    };
  }
}

// ── Result-flavored helpers (for callers in `result-response` paths) ──
//
// The class API throws on programmer errors (bad config), but most
// orchestrator call sites prefer Result. These small wrappers keep the
// neverthrow boundary at the service layer per CLAUDE.md.

export async function loadOrchestratorPipeline(
  name: string,
  scope: PipelineLoaderScope,
): Promise<
  Result<NonNullable<Awaited<ReturnType<PipelineLoader<YamlPipelineContext>['load']>>>, string>
> {
  const loader = new YamlPipelineLoader();
  const def = await loader.load(name, scope);
  if (!def) return err(`pipeline "${name}" not found`);
  return ok(def);
}
