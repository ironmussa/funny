import { describe, expect, test } from 'vitest';

import {
  applyDragRange,
  selectionStateOf,
  toggleHunk,
  toggleLine,
} from '@/lib/diff-line-selection';

describe('diff-line-selection', () => {
  test('selectionStateOf', () => {
    expect(selectionStateOf(new Set(), 3)).toBe('none');
    expect(selectionStateOf(new Set([1]), 3)).toBe('partial');
    expect(selectionStateOf(new Set([1, 2, 3]), 3)).toBe('all');
  });

  test('toggleLine returns a new set', () => {
    const base = new Set([1, 2]);
    expect([...toggleLine(base, 2)]).toEqual([1]);
    expect([...toggleLine(base, 3)]).toEqual([1, 2, 3]);
    expect([...base]).toEqual([1, 2]);
  });

  test('toggleHunk selects a partial hunk and clears a full one', () => {
    expect([...toggleHunk(new Set([1]), [1, 2])].sort()).toEqual([1, 2]);
    expect([...toggleHunk(new Set([1, 2, 5]), [1, 2])]).toEqual([5]);
  });

  test('applyDragRange only touches changeable lines inside the range', () => {
    const snapshot = new Set([1, 9]);
    const changeable = [1, 3, 4, 6, 9];
    expect([...applyDragRange(snapshot, changeable, 6, 3, true)].sort()).toEqual([1, 3, 4, 6, 9]);
    expect([...applyDragRange(snapshot, changeable, 0, 4, false)]).toEqual([9]);
    expect([...snapshot]).toEqual([1, 9]);
  });
});
