/**
 * @domain subdomain: Shared Kernel
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * Unified telemetry configuration — single source of truth for OTLP settings.
 * All modules (telemetry, logger, log ingest) read from here instead of
 * independently parsing env vars.
 */

import { isTelemetryExportEnabled } from '@funny/shared/lib/telemetry-identity';

export interface TelemetryConfig {
  /** OTLP collector endpoint (e.g. http://localhost:4000) */
  endpoint: string;
  /** Whether telemetry export is enabled */
  enabled: boolean;
  /** Service name for the server process */
  serverServiceName: string;
}

let _config: TelemetryConfig | null = null;

export function getTelemetryConfig(): TelemetryConfig {
  if (!_config) {
    const endpoint = process.env.OTLP_ENDPOINT || 'http://localhost:4000';
    _config = {
      endpoint,
      enabled: isTelemetryExportEnabled(),
      serverServiceName: 'funny-runtime',
    };
  }
  return _config;
}
