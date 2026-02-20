import { loadConfig, createResource, type ObservabilityConfig } from './config.js';
import { createTraceExporter, createMetricExporter, createLogExporter } from './exporter.js';
import { initTracer, shutdownTracer } from './tracer.js';
import { initMetrics, shutdownMetrics } from './metrics.js';
import { initLogger, shutdownLogger } from './logger.js';
import { observabilityMiddleware } from './middleware.js';
import type { MiddlewareHandler } from 'hono';

let initialized = false;

function ensureInitialized(overrides?: Partial<ObservabilityConfig>): void {
  if (initialized) return;

  const config = loadConfig(overrides);
  if (!config.enabled) {
    initialized = true;
    return;
  }

  const resource = createResource(config);
  const traceExporter = createTraceExporter(config);
  const metricExporter = createMetricExporter(config);
  const logExporter = createLogExporter(config);

  initTracer(resource, traceExporter);
  initMetrics(resource, metricExporter, config.exportIntervalMs);
  initLogger(resource, logExporter);

  initialized = true;
}

/**
 * Hono middleware that auto-instruments HTTP requests with traces and metrics.
 * Initializes the OpenTelemetry SDK on first use.
 *
 * Usage:
 *   import { observability } from '@funny/observability';
 *   app.use('*', observability());
 */
export function observability(overrides?: Partial<ObservabilityConfig>): MiddlewareHandler {
  const config = loadConfig(overrides);

  if (!config.enabled) {
    return async (_c, next) => { await next(); };
  }

  ensureInitialized(overrides);
  return observabilityMiddleware();
}

/**
 * Gracefully shuts down the OpenTelemetry SDK, flushing pending telemetry.
 * Call this in your server's shutdown handler.
 */
export async function observabilityShutdown(): Promise<void> {
  await Promise.all([shutdownTracer(), shutdownMetrics(), shutdownLogger()]);
  initialized = false;
}

export { emitLog } from './logger.js';
export type { ObservabilityConfig } from './config.js';
