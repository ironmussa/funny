import { beforeEach, describe, expect, test } from 'vitest';

import {
  GRID_CELLS_KEY,
  clearGridCell,
  getAssignedThreadIds,
  getGridCells,
  setGridCell,
} from '@/lib/grid-storage';

describe('grid-storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('returns empty object when nothing is stored', () => {
    expect(getGridCells()).toEqual({});
    expect(getAssignedThreadIds()).toEqual([]);
  });

  test('persists cell assignments under the versioned key', () => {
    setGridCell(0, 'thread-a');
    setGridCell(2, 'thread-b');

    expect(localStorage.getItem(GRID_CELLS_KEY)).toBe(
      JSON.stringify({ '0': 'thread-a', '2': 'thread-b' }),
    );
    expect(getGridCells()).toEqual({ '0': 'thread-a', '2': 'thread-b' });
    expect(getAssignedThreadIds()).toEqual(['thread-a', 'thread-b']);
  });

  test('clears a single cell assignment', () => {
    setGridCell(1, 'thread-x');
    clearGridCell(1);

    expect(getGridCells()).toEqual({});
  });

  test('returns empty object when stored JSON is invalid', () => {
    localStorage.setItem(GRID_CELLS_KEY, '{not-json');

    expect(getGridCells()).toEqual({});
  });
});
