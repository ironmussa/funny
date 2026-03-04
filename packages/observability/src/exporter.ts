import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';

import type { ObservabilityConfig } from './config.js';

function authHeaders(config: ObservabilityConfig): Record<string, string> | undefined {
  return config.authHeader ? { Authorization: config.authHeader } : undefined;
}

export function createTraceExporter(config: ObservabilityConfig): OTLPTraceExporter {
  return new OTLPTraceExporter({
    url: `${config.endpoint}/v1/traces`,
    headers: authHeaders(config),
  });
}

export function createMetricExporter(config: ObservabilityConfig): OTLPMetricExporter {
  return new OTLPMetricExporter({
    url: `${config.endpoint}/v1/metrics`,
    headers: authHeaders(config),
  });
}

export function createLogExporter(config: ObservabilityConfig): OTLPLogExporter {
  return new OTLPLogExporter({
    url: `${config.endpoint}/v1/logs`,
    headers: authHeaders(config),
  });
}
