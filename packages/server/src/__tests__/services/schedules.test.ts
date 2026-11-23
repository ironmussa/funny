/**
 * Cron schedule helpers (openspec automation-occurrence-claims): which patterns
 * can run, when one next occurs, and when an occurrence was already taken.
 */
import { describe, expect, test } from 'bun:test';

import { nextOccurrence, occurrenceTaken, scheduleProblem } from '../../services/schedules.js';

describe('scheduleProblem', () => {
  test('a cron pattern has no problem', () => {
    expect(scheduleProblem('0 9 * * *')).toBeNull();
    expect(scheduleProblem('*/5 * * * *')).toBeNull();
  });

  test('anything else says why', () => {
    for (const pattern of ['every morning', '61 * * * *', '']) {
      expect(typeof scheduleProblem(pattern)).toBe('string');
    }
  });
});

describe('nextOccurrence', () => {
  test('is the first occurrence strictly after the given time', () => {
    const from = new Date('2026-11-23T02:01:00.000Z');
    expect(nextOccurrence('*/5 * * * *', from)).toBe('2026-11-23T02:05:00.000Z');
    expect(nextOccurrence('*/5 * * * *', new Date('2026-11-23T02:05:00.000Z'))).toBe(
      '2026-11-23T02:10:00.000Z',
    );
  });

  test('is null for a pattern that cannot run', () => {
    expect(nextOccurrence('every morning', new Date())).toBeNull();
  });
});

describe('occurrenceTaken', () => {
  const due = '2026-11-23T02:05:00.000Z';
  const next = '2026-11-23T02:10:00.000Z';

  test('not taken while the stored time is still the due occurrence', () => {
    expect(occurrenceTaken(due, next)).toBe(false);
  });

  test('taken once the stored time is the following occurrence, or a later one', () => {
    expect(occurrenceTaken(next, next)).toBe(true);
    expect(occurrenceTaken('2026-11-23T02:15:00.000Z', next)).toBe(true);
  });

  test('an unknown side is left to the compare-and-set', () => {
    expect(occurrenceTaken(null, next)).toBe(false);
    expect(occurrenceTaken(due, null)).toBe(false);
  });
});
