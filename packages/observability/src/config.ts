import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

export interface ObservabilityConfig {
  enabled: boolean;
  endpoint: string;
  serviceName: string;
  serviceVersion: string;
  exportIntervalMs: number;
}

export function loadConfig(overrides?: Partial<ObservabilityConfig>): ObservabilityConfig {
  return {
    enabled: overrides?.enabled ?? process.env.OTEL_ENABLED !== 'false',
    endpoint: overrides?.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318',
    serviceName: overrides?.serviceName ?? process.env.OTEL_SERVICE_NAME ?? 'funny-server',
    serviceVersion: overrides?.serviceVersion ?? process.env.OTEL_SERVICE_VERSION ?? '0.1.0',
    exportIntervalMs: overrides?.exportIntervalMs ?? (Number(process.env.OTEL_EXPORT_INTERVAL_MS) || 10_000),
  };
}

export function createResource(config: ObservabilityConfig): Resource {
  return new Resource({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion,
  });
}
