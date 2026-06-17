import { describe, test, expect } from 'vitest';

import { firstPlacedThreadId, resolveGridSelection } from '@/lib/grid-selection';

describe('firstPlacedThreadId', () => {
  test('returns null for an empty grid', () => {
    expect(firstPlacedThreadId({}, 2, 2)).toBeNull();
  });

  test('returns the only thread in a 1x1 grid', () => {
    expect(firstPlacedThreadId({ '0': 't1' }, 1, 1)).toBe('t1');
  });

  test('scans row-major (top row before second column)', () => {
    // 2x2 grid: cell 1 (row 0, col 1) is occupied; cell 2 (row 1, col 0) too.
    // Row-major order visits 0,1,2,3 → first occupied is index 1.
    expect(firstPlacedThreadId({ '1': 'b', '2': 'a' }, 2, 2)).toBe('b');
  });

  test('ignores cells outside the current rows/cols', () => {
    // Index 5 exists in storage but the grid is only 2x2 (indices 0..3).
    expect(firstPlacedThreadId({ '5': 'stale' }, 2, 2)).toBeNull();
  });
});

describe('resolveGridSelection', () => {
  const set = (...ids: string[]) => new Set(ids);

  test('auto-selects the first placed thread on initial resolution', () => {
    expect(
      resolveGridSelection({
        current: null,
        placedIds: set('a', 'b'),
        firstPlaced: 'a',
        inited: false,
        prevHadThreads: false,
      }),
    ).toBe('a');
  });

  test('keeps a still-placed selection on reload (no change)', () => {
    expect(
      resolveGridSelection({
        current: 'b',
        placedIds: set('a', 'b'),
        firstPlaced: 'a',
        inited: false,
        prevHadThreads: false,
      }),
    ).toBe('b');
  });

  test('falls back to first when the persisted selection is no longer placed', () => {
    expect(
      resolveGridSelection({
        current: 'gone',
        placedIds: set('a', 'b'),
        firstPlaced: 'a',
        inited: false,
        prevHadThreads: false,
      }),
    ).toBe('a');
  });

  test('strict-clears when the selected thread is removed mid-session', () => {
    // inited=true, others remain placed → clear to null (no auto-jump).
    expect(
      resolveGridSelection({
        current: 'gone',
        placedIds: set('a', 'b'),
        firstPlaced: 'a',
        inited: true,
        prevHadThreads: true,
      }),
    ).toBeNull();
  });

  test('clears to null when the selected thread was the last one', () => {
    expect(
      resolveGridSelection({
        current: 'gone',
        placedIds: set(),
        firstPlaced: null,
        inited: true,
        prevHadThreads: true,
      }),
    ).toBeNull();
  });

  test('auto-selects when a thread first appears in a previously-empty grid', () => {
    expect(
      resolveGridSelection({
        current: null,
        placedIds: set('a'),
        firstPlaced: 'a',
        inited: true,
        prevHadThreads: false,
      }),
    ).toBe('a');
  });

  test('does not re-select after a mid-session clear while threads remain', () => {
    // null selection, inited, grid already had threads → stay null.
    expect(
      resolveGridSelection({
        current: null,
        placedIds: set('a', 'b'),
        firstPlaced: 'a',
        inited: true,
        prevHadThreads: true,
      }),
    ).toBeNull();
  });

  test('stays null on an empty grid at mount', () => {
    expect(
      resolveGridSelection({
        current: null,
        placedIds: set(),
        firstPlaced: null,
        inited: false,
        prevHadThreads: false,
      }),
    ).toBeNull();
  });
});
