import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

export interface ObservabilityConfig {
  enabled: boolean;
  endpoint: string;
  serviceName: string;
  serviceVersion: string;
  exportIntervalMs: number;
  authHeader?: string;
}

export function loadConfig(overrides?: Partial<ObservabilityConfig>): ObservabilityConfig {
  return {
    enabled: overrides?.enabled ?? process.env.OTEL_ENABLED === 'true',
    endpoint:
      overrides?.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318',
    serviceName: overrides?.serviceName ?? process.env.OTEL_SERVICE_NAME ?? 'funny-server',
    serviceVersion: overrides?.serviceVersion ?? process.env.OTEL_SERVICE_VERSION ?? '0.1.0',
    exportIntervalMs:
      overrides?.exportIntervalMs ?? (Number(process.env.OTEL_EXPORT_INTERVAL_MS) || 10_000),
    authHeader: overrides?.authHeader ?? parseAuthHeader(),
  };
}

/**
 * Parse OTLP auth from env vars.
 * Supports:
 *   OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic ... (standard OTLP env var)
 *   OTEL_EXPORTER_OTLP_AUTH=Basic:user:pass (convenience format → base64-encoded)
 */
function parseAuthHeader(): string | undefined {
  const headers = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  if (headers) {
    const match = headers.match(/Authorization=(.+)/i);
    if (match) return match[1];
  }

  const auth = process.env.OTEL_EXPORTER_OTLP_AUTH;
  if (auth) {
    const [scheme, ...rest] = auth.split(':');
    const credentials = rest.join(':');
    if (scheme === 'Basic' && credentials) {
      return `Basic ${Buffer.from(credentials).toString('base64')}`;
    }
    return auth;
  }

  return undefined;
}

export function createResource(config: ObservabilityConfig) {
  return resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion,
  });
}
