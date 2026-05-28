/**
 * Security HI-12 regression tests for per-identifier login throttle.
 */
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';

import {
  _resetLoginThrottle,
  checkLoginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
} from '../../lib/login-throttle.js';

afterEach(() => {
  _resetLoginThrottle();
  setSystemTime();
});

describe('login-throttle (security HI-12)', () => {
  test('allows attempts under the threshold', () => {
    for (let i = 0; i < 9; i++) {
      recordLoginFailure('alice');
    }
    expect(checkLoginAllowed('alice').ok).toBe(true);
  });

  test('locks the account after the threshold is reached', () => {
    for (let i = 0; i < 10; i++) {
      recordLoginFailure('alice');
    }
    const status = checkLoginAllowed('alice');
    expect(status.ok).toBe(false);
    if (!status.ok) {
      expect(status.retryAfterSec).toBeGreaterThan(0);
    }
  });

  test('normalises identifiers — uppercase / whitespace tolerated', () => {
    for (let i = 0; i < 10; i++) {
      recordLoginFailure('  Alice  ');
    }
    expect(checkLoginAllowed('alice').ok).toBe(false);
    expect(checkLoginAllowed('ALICE').ok).toBe(false);
  });

  test('failures against different identifiers do not cross-contaminate', () => {
    for (let i = 0; i < 10; i++) {
      recordLoginFailure('alice');
    }
    expect(checkLoginAllowed('alice').ok).toBe(false);
    expect(checkLoginAllowed('bob').ok).toBe(true);
  });

  test('successful login resets the counter immediately', () => {
    for (let i = 0; i < 9; i++) {
      recordLoginFailure('alice');
    }
    recordLoginSuccess('alice');
    for (let i = 0; i < 9; i++) {
      recordLoginFailure('alice');
    }
    expect(checkLoginAllowed('alice').ok).toBe(true);
  });

  test('lockout expires once the cooldown elapses (advance fake time)', () => {
    setSystemTime(new Date('2026-01-01T00:00:00Z'));
    for (let i = 0; i < 10; i++) {
      recordLoginFailure('alice');
    }
    expect(checkLoginAllowed('alice').ok).toBe(false);
    // Advance past the lockout duration (5 minutes).
    setSystemTime(new Date('2026-01-01T00:06:00Z'));
    expect(checkLoginAllowed('alice').ok).toBe(true);
  });

  test('failures older than the window do not count toward lockout', () => {
    setSystemTime(new Date('2026-01-01T00:00:00Z'));
    for (let i = 0; i < 9; i++) {
      recordLoginFailure('alice');
    }
    // Jump past the 15-min window.
    setSystemTime(new Date('2026-01-01T00:20:00Z'));
    recordLoginFailure('alice');
    expect(checkLoginAllowed('alice').ok).toBe(true);
  });
});
