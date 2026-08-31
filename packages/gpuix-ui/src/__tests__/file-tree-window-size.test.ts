import { describe, expect, test } from 'bun:test';

import {
  FILE_TREE_MAX_RETAINED_ROWS,
  FILE_TREE_MIN_RETAINED_ROWS,
  fileTreeWindowSizeForViewport,
  fileTreeWindowSizeForVisibleRange,
} from '../file-tree-window';

describe('file tree retained-window sizing', () => {
  test('derives initial capacity from viewport height instead of a fixed window', () => {
    expect(fileTreeWindowSizeForViewport(900, 1_000)).toBe(48);
    expect(fileTreeWindowSizeForViewport(500, 1_000)).toBe(32);
  });

  test('clamps small, malformed, and oversized viewport estimates', () => {
    expect(fileTreeWindowSizeForViewport(Number.NaN, 1_000)).toBe(FILE_TREE_MIN_RETAINED_ROWS);
    expect(fileTreeWindowSizeForViewport(10_000, 1_000)).toBe(FILE_TREE_MAX_RETAINED_ROWS);
    expect(fileTreeWindowSizeForViewport(900, 12)).toBe(12);
    expect(fileTreeWindowSizeForViewport(900, 0)).toBe(0);
  });

  test('adds symmetric overscan to the native visible range', () => {
    expect(fileTreeWindowSizeForVisibleRange(20, 38, 1_000)).toBe(30);
    expect(fileTreeWindowSizeForVisibleRange(995, 1_200, 1_000)).toBe(17);
    expect(fileTreeWindowSizeForVisibleRange(0, 20, 24)).toBe(24);
  });
});
