import { describe, expect, test } from 'vitest';

import { isOtlpEnabled } from '@/lib/otlp-config';

describe('isOtlpEnabled', () => {
  test('stays disabled without an endpoint', () => {
    expect(isOtlpEnabled(undefined, 'true')).toBe(false);
    expect(isOtlpEnabled('   ', 'true')).toBe(false);
  });

  test('enables whenever an endpoint is configured, in dev as well as prod', () => {
    expect(isOtlpEnabled('http://collector:4000', undefined)).toBe(true);
    expect(isOtlpEnabled('http://localhost:4000', undefined)).toBe(true);
  });

  test('allows an explicit opt-out to silence a noisy tab', () => {
    expect(isOtlpEnabled('http://collector:4000', 'false')).toBe(false);
    expect(isOtlpEnabled('http://collector:4000', '0')).toBe(false);
    expect(isOtlpEnabled('http://localhost:4000', 'off')).toBe(false);
    expect(isOtlpEnabled('http://localhost:4000', 'no')).toBe(false);
  });

  test('treats an explicit opt-in and an unrecognized flag as enabled', () => {
    expect(isOtlpEnabled('http://localhost:4000', 'true')).toBe(true);
    expect(isOtlpEnabled('http://localhost:4000', 'on')).toBe(true);
    expect(isOtlpEnabled('http://localhost:4000', 'maybe')).toBe(true);
  });
});
