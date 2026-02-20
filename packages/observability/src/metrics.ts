import { metrics, type Meter, type Counter, type Histogram, type UpDownCounter } from '@opentelemetry/api';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import type { Resource } from '@opentelemetry/resources';
import type { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';

let meterProvider: MeterProvider | null = null;

export interface HttpInstruments {
  requestDuration: Histogram;
  requestTotal: Counter;
  activeRequests: UpDownCounter;
}

export function initMetrics(resource: Resource, exporter: OTLPMetricExporter, exportIntervalMs: number): void {
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: exportIntervalMs,
  });

  meterProvider = new MeterProvider({
    resource,
    readers: [reader],
  });

  metrics.setGlobalMeterProvider(meterProvider);
}

export function createHttpInstruments(meter: Meter): HttpInstruments {
  return {
    requestDuration: meter.createHistogram('http.server.request.duration', {
      description: 'Duration of HTTP server requests in milliseconds',
      unit: 'ms',
    }),
    requestTotal: meter.createCounter('http.server.request.total', {
      description: 'Total number of HTTP server requests',
    }),
    activeRequests: meter.createUpDownCounter('http.server.active_requests', {
      description: 'Number of in-flight HTTP server requests',
    }),
  };
}

export function getMeter(name = 'funny-server') {
  return metrics.getMeter(name);
}

export async function shutdownMetrics(): Promise<void> {
  if (meterProvider) {
    await meterProvider.shutdown();
    meterProvider = null;
  }
}
