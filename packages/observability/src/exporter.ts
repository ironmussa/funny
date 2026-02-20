import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import type { ObservabilityConfig } from './config.js';

export function createTraceExporter(config: ObservabilityConfig): OTLPTraceExporter {
  return new OTLPTraceExporter({
    url: `${config.endpoint}/v1/traces`,
  });
}

export function createMetricExporter(config: ObservabilityConfig): OTLPMetricExporter {
  return new OTLPMetricExporter({
    url: `${config.endpoint}/v1/metrics`,
  });
}

export function createLogExporter(config: ObservabilityConfig): OTLPLogExporter {
  return new OTLPLogExporter({
    url: `${config.endpoint}/v1/logs`,
  });
}
