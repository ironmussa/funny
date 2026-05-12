/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: composition-root
 * @domain layer: application
 *
 * Lazy singleton for the runtime-side `OrchestratorPipelineDispatcher`
 * (provided by `@funny/orchestrator`).
 *
 * The runner exposes a small REST surface (POST `/api/orchestrator/dispatch`,
 * POST `/api/orchestrator/cancel/:pipelineRunId`) that the server's
 * `PipelineDispatchTunnelAdapter` calls when the pipeline-driven dispatcher
 * is selected. Both routes need to share the same in-process dispatcher
 * instance (so cancel can find the active handle), so we pin it to a
 * module-level singleton.
 */

import { OrchestratorPipelineDispatcher } from '@funny/thread-orchestrator';

import { log } from '../lib/logger.js';
import type { YamlPipelineContext } from '../pipelines/yaml-compiler.js';
import {
  RuntimeActionProviderFactory,
  YamlContextBuilder,
  YamlPipelineLoader,
} from './orchestrator-pipeline-adapters.js';

export type RuntimeOrchestratorPipelineDispatcher =
  OrchestratorPipelineDispatcher<YamlPipelineContext>;

let _instance: RuntimeOrchestratorPipelineDispatcher | null = null;

export function getOrchestratorPipelineDispatcher(): RuntimeOrchestratorPipelineDispatcher {
  if (_instance) return _instance;
  _instance = new OrchestratorPipelineDispatcher<YamlPipelineContext>({
    pipelines: new YamlPipelineLoader(),
    contextBuilder: new YamlContextBuilder(new RuntimeActionProviderFactory()),
    log,
  });
  return _instance;
}

/** Test seam — replace the singleton in unit tests. */
export function setOrchestratorPipelineDispatcher(
  d: RuntimeOrchestratorPipelineDispatcher | null,
): void {
  _instance = d;
}
