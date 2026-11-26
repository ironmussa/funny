import { describe, test, expect } from 'bun:test';

import { effectiveThreadId, isRightPaneVisible, rightPaneProjectId } from '@/lib/grid-right-pane';

describe('effectiveThreadId', () => {
  test('uses the grid selection while the grid is open', () => {
    expect(effectiveThreadId(true, 'grid-thread', 'url-thread')).toBe('grid-thread');
  });

  test('is null in the grid when nothing is selected', () => {
    expect(effectiveThreadId(true, null, 'url-thread')).toBeNull();
  });

  test('uses the URL thread when the grid is closed (no leak)', () => {
    // Even with a stale grid selection present, a closed grid must not affect
    // the app-level thread context.
    expect(effectiveThreadId(false, 'grid-thread', 'url-thread')).toBe('url-thread');
    expect(effectiveThreadId(false, 'grid-thread', null)).toBeNull();
  });
});

describe('isRightPaneVisible', () => {
  test('hidden when the review pane flag is off', () => {
    expect(isRightPaneVisible(false, false, true)).toBe(false);
  });

  test('visible in a view that hosts the tools (thread, grid, analytics, tests)', () => {
    expect(isRightPaneVisible(true, false, true)).toBe(true);
  });

  test('hidden when there is no thread and no selected project', () => {
    expect(isRightPaneVisible(true, false, false)).toBe(false);
  });

  test('hidden under a full-screen view that takes the whole window', () => {
    // e.g. settings or workflows.
    expect(isRightPaneVisible(true, true, true)).toBe(false);
  });
});

describe('rightPaneProjectId', () => {
  test('uses the grid thread project while the grid is open', () => {
    expect(rightPaneProjectId(true, 'grid-thread', 'grid-proj', 'store-proj')).toBe('grid-proj');
  });

  test('is null in the grid when the selected thread has no project', () => {
    expect(rightPaneProjectId(true, 'grid-thread', null, 'store-proj')).toBeNull();
  });

  test('falls back to the store project in the grid when no thread is selected', () => {
    expect(rightPaneProjectId(true, null, null, 'store-proj')).toBe('store-proj');
  });

  test('uses the store project when the grid is closed (no leak)', () => {
    expect(rightPaneProjectId(false, 'grid-thread', 'grid-proj', 'store-proj')).toBe('store-proj');
  });
});
