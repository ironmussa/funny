import { describe, expect, test } from 'vitest';

import {
  currentUtilization,
  formatResetsIn,
  planLabel,
  usageWindowLabel,
} from '../agent-account-format';

const now = Date.parse('2026-11-21T12:00:00Z');

describe('agent account format', () => {
  test('labels known windows and per-model ones', () => {
    expect(usageWindowLabel({ key: 'five_hour', utilization: 1, resetsAt: null })).toBe(
      'Current session (5h)',
    );
    expect(
      usageWindowLabel({ key: 'model:Fable', label: 'Fable', utilization: 1, resetsAt: null }),
    ).toBe('Weekly · Fable');
  });

  test('formats the reset time', () => {
    expect(formatResetsIn('2026-11-21T14:13:00Z', now)).toBe('resets in 2h 13m');
    expect(formatResetsIn('2026-11-24T16:00:00Z', now)).toBe('resets in 3d 4h');
    expect(formatResetsIn('2026-11-21T12:05:00Z', now)).toBe('resets in 5m');
    expect(formatResetsIn('2026-11-21T11:00:00Z', now)).toBe('reset');
    expect(formatResetsIn(null, now)).toBeNull();
  });

  test('a window whose reset passed since the snapshot counts as 0%', () => {
    expect(
      currentUtilization(
        { key: 'five_hour', utilization: 80, resetsAt: '2026-11-21T11:00:00Z' },
        now,
      ),
    ).toBe(0);
    expect(
      currentUtilization(
        { key: 'five_hour', utilization: 80, resetsAt: '2026-11-21T13:00:00Z' },
        now,
      ),
    ).toBe(80);
    expect(
      currentUtilization({ key: 'five_hour', utilization: null, resetsAt: null }, now),
    ).toBeNull();
  });

  test('capitalizes the plan', () => {
    expect(planLabel('max')).toBe('Max');
    expect(planLabel(undefined)).toBeUndefined();
  });
});
