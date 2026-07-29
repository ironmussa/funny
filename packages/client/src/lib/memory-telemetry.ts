/**
 * Forwards memory-profiler samples into Abbacchio as gauge metrics so a
 * profiling run is persisted and can be queried after the tab is gone.
 *
 * The profiler's in-memory history is bounded and dies with the page; these
 * metrics are the durable copy. See
 * openwiki/operations/client-memory-diagnostics.md for the query recipes.
 */

import { toMemoryProfilerMetrics, type MemoryProfilerSample } from '@abbacchio/browser-transport';

import { metric } from './telemetry';

/** Metric namespace for every series derived from a memory sample. */
export const MEMORY_METRIC_PREFIX = 'client.memory';

/**
 * Publishes one sample as a set of gauge points. Each point carries the run's
 * `sessionId`, so a single profiling run can be reassembled when querying.
 */
export function publishMemorySample(sample: MemoryProfilerSample): void {
  for (const point of toMemoryProfilerMetrics(sample, { prefix: MEMORY_METRIC_PREFIX })) {
    metric(point.name, point.value, { type: 'gauge', attributes: point.attributes });
  }
}
