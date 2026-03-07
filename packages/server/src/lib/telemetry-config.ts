/**
 * @domain subdomain: Shared Kernel
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * Unified telemetry configuration — single source of truth for OTLP settings.
 * All modules (telemetry, logger, log ingest) read from here instead of
 * independently parsing env vars.
 */

export interface TelemetryConfig {
  /** OTLP collector endpoint (e.g. http://localhost:4000) */
  endpoint: string;
  /** Whether telemetry export is enabled */
  enabled: boolean;
  /** Service name for the server process */
  serverServiceName: string;
  /** Service name for browser log forwarding */
  browserServiceName: string;
}

let _config: TelemetryConfig | null = null;

export function getTelemetryConfig(): TelemetryConfig {
  if (!_config) {
    const endpoint = process.env.OTLP_ENDPOINT || 'http://localhost:4000';
    _config = {
      endpoint,
      enabled: !!process.env.OTLP_ENDPOINT,
      serverServiceName: 'funny-server',
      browserServiceName: 'funny-browser',
    };
  }
  return _config;
}
