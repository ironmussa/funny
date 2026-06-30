/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: composition-root
 * @domain layer: application
 *
 * Lazy singleton for the runtime-side `SchedulerPipelineDispatcher`
 * (provided by `@funny/scheduler`).
 *
 * The runner exposes a small REST surface (POST `/api/scheduler/dispatch`,
 * POST `/api/scheduler/cancel/:pipelineRunId`) that the server's
 * `PipelineDispatchTunnelAdapter` calls when the pipeline-driven dispatcher
 * is selected. Both routes need to share the same in-process dispatcher
 * instance (so cancel can find the active handle), so we pin it to a
 * module-level singleton.
 */

import { SchedulerPipelineDispatcher } from '@funny/thread-scheduler';

import { log } from '../lib/logger.js';
import type { YamlPipelineContext } from '../pipelines/yaml-compiler.js';
import {
  RuntimeActionProviderFactory,
  YamlContextBuilder,
  YamlPipelineLoader,
} from './scheduler-pipeline-adapters.js';

export type RuntimeSchedulerPipelineDispatcher =
  SchedulerPipelineDispatcher<YamlPipelineContext>;

let _instance: RuntimeSchedulerPipelineDispatcher | null = null;

export function getSchedulerPipelineDispatcher(): RuntimeSchedulerPipelineDispatcher {
  if (_instance) return _instance;
  _instance = new SchedulerPipelineDispatcher<YamlPipelineContext>({
    pipelines: new YamlPipelineLoader(),
    contextBuilder: new YamlContextBuilder(new RuntimeActionProviderFactory()),
    log,
  });
  return _instance;
}

/** Test seam — replace the singleton in unit tests. */
export function setSchedulerPipelineDispatcher(
  d: RuntimeSchedulerPipelineDispatcher | null,
): void {
  _instance = d;
}
