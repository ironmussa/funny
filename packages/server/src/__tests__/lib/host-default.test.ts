/**
 * Security CR-7 regression — server HOST defaults to loopback when the
 * env var is unset, so a fresh install isn't reachable from the LAN before
 * the operator rotates the auto-generated admin password.
 */
import { describe, expect, test } from 'bun:test';

import { resolveHost } from '../../lib/host-default.js';

describe('resolveHost (security CR-7)', () => {
  test('defaults to 127.0.0.1 when env is undefined', () => {
    expect(resolveHost(undefined)).toBe('127.0.0.1');
  });

  test('defaults to 127.0.0.1 when env is empty string', () => {
    expect(resolveHost('')).toBe('127.0.0.1');
  });

  test('honours an explicit 0.0.0.0 (operator opt-in)', () => {
    expect(resolveHost('0.0.0.0')).toBe('0.0.0.0');
  });

  test('honours an explicit LAN address', () => {
    expect(resolveHost('192.168.1.10')).toBe('192.168.1.10');
  });

  test('honours an explicit IPv6 address', () => {
    expect(resolveHost('::')).toBe('::');
    expect(resolveHost('::1')).toBe('::1');
  });
});
