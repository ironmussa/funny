import { describe, expect, test } from 'bun:test';

import { isTelemetryExportEnabled, isTestProcess } from '../lib/telemetry-identity';

describe('telemetry export gate', () => {
  test('exports only when OTLP_ENDPOINT is set', () => {
    expect(isTelemetryExportEnabled({ OTLP_ENDPOINT: 'http://localhost:4000' })).toBe(true);
    expect(isTelemetryExportEnabled({})).toBe(false);
  });

  test('never exports from a test run, even with the developer .env loaded', () => {
    const env = { OTLP_ENDPOINT: 'http://localhost:4000', NODE_ENV: 'test' };
    expect(isTestProcess(env)).toBe(true);
    expect(isTelemetryExportEnabled(env)).toBe(false);
  });
});
