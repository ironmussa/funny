import { describe, test, expect, beforeEach } from 'bun:test';

import { clearSocketRate, isRateLimited } from '../../services/socketio-rate-limit.js';

describe('socketio-rate-limit', () => {
  beforeEach(() => {
    clearSocketRate('sock-1');
    clearSocketRate('sock-2');
  });

  test('allows messages under the window limit', () => {
    expect(isRateLimited('sock-1', 3, 10_000)).toBe(false);
    expect(isRateLimited('sock-1', 3, 10_000)).toBe(false);
    expect(isRateLimited('sock-1', 3, 10_000)).toBe(false);
  });

  test('drops messages once the window limit is reached', () => {
    expect(isRateLimited('sock-1', 2, 10_000)).toBe(false);
    expect(isRateLimited('sock-1', 2, 10_000)).toBe(false);
    expect(isRateLimited('sock-1', 2, 10_000)).toBe(true);
  });

  test('tracks sockets independently', () => {
    expect(isRateLimited('sock-1', 1, 10_000)).toBe(false);
    expect(isRateLimited('sock-1', 1, 10_000)).toBe(true);
    expect(isRateLimited('sock-2', 1, 10_000)).toBe(false);
  });

  test('clearSocketRate resets the counter', () => {
    expect(isRateLimited('sock-1', 1, 10_000)).toBe(false);
    expect(isRateLimited('sock-1', 1, 10_000)).toBe(true);
    clearSocketRate('sock-1');
    expect(isRateLimited('sock-1', 1, 10_000)).toBe(false);
  });
});
