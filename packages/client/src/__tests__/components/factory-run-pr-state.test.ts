import { describe, expect, test } from 'bun:test';

import {
  factoryRunPrState,
  factoryRunPrStateUnknown,
} from '@/components/factory-board/run-pr-state';

const pr = 'https://github.com/o/r/pull/506';

describe('factory run PR state', () => {
  test('a stopped run whose PR GitHub reports closed shows it closed, not open', () => {
    const run = { state: 'stopped' as const, prUrl: pr };
    expect(factoryRunPrStateUnknown(run)).toBe(true);
    expect(factoryRunPrState(run, { state: 'closed', merged: false })).toBe('CLOSED');
    expect(factoryRunPrState(run, { state: 'closed', merged: true })).toBe('MERGED');
    expect(factoryRunPrState(run, { state: 'open', merged: false })).toBe('OPEN');
  });

  test('a merged run, or one still in flight, needs no lookup', () => {
    expect(factoryRunPrStateUnknown({ state: 'merged', prUrl: pr })).toBe(false);
    expect(factoryRunPrStateUnknown({ state: 'waiting_human', prUrl: pr })).toBe(false);
    expect(factoryRunPrStateUnknown({ state: 'stopped', prUrl: null })).toBe(false);
    expect(factoryRunPrState({ state: 'merged', prUrl: pr }, undefined)).toBe('MERGED');
    expect(factoryRunPrState({ state: 'waiting_human', prUrl: pr }, undefined)).toBe('OPEN');
  });
});
