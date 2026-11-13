/**
 * Security HI-12 regression tests for per-identifier login throttle.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from 'bun:test';

import { log } from '../../lib/logger.js';
import {
  _loginThrottleSize,
  _resetLoginThrottle,
  checkLoginAllowed,
  MAX_IDENTIFIER_LENGTH,
  MAX_TRACKED_IDENTIFIERS,
  recordLoginFailure,
  recordLoginSuccess,
} from '../../lib/login-throttle.js';

// The cap tests record >10k failures, each audited. Silence the audit log so
// the output stays small: the coverage gate buffers the child's output and
// fails when it overflows.
let logInfo: ReturnType<typeof spyOn>;
beforeAll(() => {
  logInfo = spyOn(log, 'info').mockImplementation(() => log);
});
afterAll(() => logInfo.mockRestore());

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

  test('expired records are dropped instead of accumulating (#197)', () => {
    setSystemTime(new Date('2026-01-01T00:00:00Z'));
    for (let i = 0; i < 50; i++) recordLoginFailure(`user-${i}`);
    for (let i = 0; i < 10; i++) recordLoginFailure('locked');
    expect(_loginThrottleSize()).toBe(51);
    // Past both the 15-min window and the 5-min lockout of every record.
    setSystemTime(new Date('2026-01-01T00:30:00Z'));
    recordLoginFailure('fresh');
    expect(_loginThrottleSize()).toBe(1);
  });

  test('a record whose lockout outlasts its window is kept until the lockout ends', () => {
    setSystemTime(new Date('2026-01-01T00:00:00Z'));
    for (let i = 0; i < 9; i++) recordLoginFailure('alice');
    // 10th failure at minute 14 locks until minute 19, past the window (minute 15).
    setSystemTime(new Date('2026-01-01T00:14:00Z'));
    recordLoginFailure('alice');
    setSystemTime(new Date('2026-01-01T00:17:00Z'));
    recordLoginFailure('other');
    expect(checkLoginAllowed('alice').ok).toBe(false);
  });

  test('the map never holds more than the cap, even inside the window (#197)', () => {
    setSystemTime(new Date('2026-01-01T00:00:00Z'));
    for (let i = 0; i < MAX_TRACKED_IDENTIFIERS + 500; i++) {
      recordLoginFailure(`spray-${i}`);
    }
    expect(_loginThrottleSize()).toBeLessThanOrEqual(MAX_TRACKED_IDENTIFIERS);
    // The most recent identifiers are the ones kept.
    for (let i = 0; i < 9; i++) recordLoginFailure(`spray-${MAX_TRACKED_IDENTIFIERS + 499}`);
    expect(checkLoginAllowed(`spray-${MAX_TRACKED_IDENTIFIERS + 499}`).ok).toBe(false);
  });

  test('flooding new identifiers does not evict a locked account (#197)', () => {
    setSystemTime(new Date('2026-01-01T00:00:00Z'));
    for (let i = 0; i < 10; i++) recordLoginFailure('alice');
    for (let i = 0; i < MAX_TRACKED_IDENTIFIERS + 500; i++) {
      recordLoginFailure(`spray-${i}`);
    }
    expect(checkLoginAllowed('alice').ok).toBe(false);
  });

  test('oversized identifiers are stored truncated, not whole (#197)', () => {
    const huge = 'x'.repeat(1_000_000);
    for (let i = 0; i < 10; i++) recordLoginFailure(huge);
    expect(_loginThrottleSize()).toBe(1);
    // Same bucket as its truncated prefix: the key is bounded.
    expect(checkLoginAllowed('x'.repeat(MAX_IDENTIFIER_LENGTH)).ok).toBe(false);
  });

  test('the oldest unlocked identifiers are the ones evicted (#197)', () => {
    setSystemTime(new Date('2026-01-01T00:00:00Z'));
    for (let i = 0; i < 9; i++) recordLoginFailure('spray-0');
    for (let i = 1; i <= MAX_TRACKED_IDENTIFIERS; i++) recordLoginFailure(`spray-${i}`);
    // spray-0 was evicted, so one more failure does not lock it.
    recordLoginFailure('spray-0');
    expect(checkLoginAllowed('spray-0').ok).toBe(true);
  });
});
