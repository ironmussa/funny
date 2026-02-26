import { describe, test, expect } from 'bun:test';

import { resolveAuthMode, getAuthMode } from '../../lib/auth-mode.js';

describe('resolveAuthMode', () => {
  test('returns "local" when value is undefined', () => {
    expect(resolveAuthMode(undefined)).toBe('local');
  });

  test('returns "local" when value is empty string', () => {
    expect(resolveAuthMode('')).toBe('local');
  });

  test('returns "multi" when value is "multi"', () => {
    expect(resolveAuthMode('multi')).toBe('multi');
  });

  test('returns "multi" when value is "MULTI" (case insensitive)', () => {
    expect(resolveAuthMode('MULTI')).toBe('multi');
  });

  test('returns "multi" when value is "Multi" (mixed case)', () => {
    expect(resolveAuthMode('Multi')).toBe('multi');
  });

  test('returns "local" for unrecognized values', () => {
    expect(resolveAuthMode('invalid')).toBe('local');
  });

  test('returns "local" when value is "local"', () => {
    expect(resolveAuthMode('local')).toBe('local');
  });

  test('returns "local" when value is "LOCAL"', () => {
    expect(resolveAuthMode('LOCAL')).toBe('local');
  });

  test('returns "local" when value is whitespace', () => {
    expect(resolveAuthMode('   ')).toBe('local');
  });
});

describe('getAuthMode', () => {
  test('return type is "local" or "multi"', () => {
    expect(['local', 'multi']).toContain(getAuthMode());
  });
});
