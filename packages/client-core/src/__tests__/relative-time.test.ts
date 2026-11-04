import { describe, expect, test } from 'bun:test';

import { formatCompactElapsed } from '../relative-time';

const NOW = Date.UTC(2026, 0, 1);
const ago = (seconds: number) => NOW - seconds * 1000;

describe('formatCompactElapsed', () => {
  test.each([
    [0, 'now'],
    [59, 'now'],
    [60, '1m'],
    [59 * 60, '59m'],
    [60 * 60, '1h'],
    [24 * 3600, '1d'],
    [29 * 86400, '29d'],
    [30 * 86400, '1mo'],
    [360 * 86400, '1y'],
  ])('%i seconds ago is %s', (seconds, label) => {
    expect(formatCompactElapsed(ago(seconds), NOW)).toBe(label);
  });

  test('a time in the future is "now"', () => {
    expect(formatCompactElapsed(NOW + 5000, NOW)).toBe('now');
  });
});
