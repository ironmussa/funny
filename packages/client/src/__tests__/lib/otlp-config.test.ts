import { describe, expect, test } from 'vitest';

import { isOtlpEnabled } from '@/lib/otlp-config';

describe('isOtlpEnabled', () => {
  test('stays disabled without an endpoint', () => {
    expect(isOtlpEnabled(undefined, 'true', true)).toBe(false);
    expect(isOtlpEnabled('   ', 'true', true)).toBe(false);
  });

  test('enables by default in production when endpoint is configured', () => {
    expect(isOtlpEnabled('http://collector:4000', undefined, true)).toBe(true);
  });

  test('stays disabled by default in development when endpoint is configured', () => {
    expect(isOtlpEnabled('http://localhost:4000', undefined, false)).toBe(false);
  });

  test('allows explicit dev opt-in and prod opt-out', () => {
    expect(isOtlpEnabled('http://localhost:4000', 'true', false)).toBe(true);
    expect(isOtlpEnabled('http://collector:4000', 'false', true)).toBe(false);
    expect(isOtlpEnabled('http://collector:4000', '0', true)).toBe(false);
    expect(isOtlpEnabled('http://collector:4000', 'on', false)).toBe(true);
  });
});
