/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: composition-root
 * @domain layer: application
 *
 * Lazy singleton for the runtime's `PipelineDispatcher`.
 *
 * The workflow routes (`POST /api/workflows/:name/run`, `POST
 * /api/workflows/runs/:runId/cancel`) share one in-process dispatcher, so a
 * cancel can find the active handle of a run.
 */

import type { YamlPipelineContext } from '@funny/workflows/compiler';

import { log } from '../lib/logger.js';
import {
  RuntimeActionProviderFactory,
  YamlContextBuilder,
  YamlPipelineLoader,
} from './pipeline-dispatcher-adapters.js';
import { PipelineDispatcher } from './pipeline-dispatcher.js';

export type RuntimePipelineDispatcher = PipelineDispatcher<YamlPipelineContext>;

let _instance: RuntimePipelineDispatcher | null = null;

export function getPipelineDispatcher(): RuntimePipelineDispatcher {
  if (_instance) return _instance;
  _instance = new PipelineDispatcher<YamlPipelineContext>({
    pipelines: new YamlPipelineLoader(),
    contextBuilder: new YamlContextBuilder(new RuntimeActionProviderFactory()),
    log,
  });
  return _instance;
}
