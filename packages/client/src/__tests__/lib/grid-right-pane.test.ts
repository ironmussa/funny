import { describe, test, expect } from 'vitest';

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
    expect(isRightPaneVisible(false, false, false, null)).toBe(false);
  });

  test('visible in the normal (non-full-screen) view', () => {
    expect(isRightPaneVisible(true, false, false, null)).toBe(true);
  });

  test('hidden under a non-grid full-screen view', () => {
    // e.g. settings/analytics open — isFullScreenView true, grid not open.
    expect(isRightPaneVisible(true, true, false, null)).toBe(false);
  });

  test('visible in the grid when a thread is selected', () => {
    expect(isRightPaneVisible(true, true, true, 'grid-thread')).toBe(true);
  });

  test('hidden in the grid when nothing is selected', () => {
    expect(isRightPaneVisible(true, true, true, null)).toBe(false);
  });

  test('still gated on the review pane flag even in the grid', () => {
    expect(isRightPaneVisible(false, true, true, 'grid-thread')).toBe(false);
  });
});

describe('rightPaneProjectId', () => {
  test('uses the grid thread project while the grid is open', () => {
    expect(rightPaneProjectId(true, 'grid-proj', 'store-proj')).toBe('grid-proj');
  });

  test('is null in the grid when the selected thread has no project', () => {
    expect(rightPaneProjectId(true, null, 'store-proj')).toBeNull();
  });

  test('uses the store project when the grid is closed (no leak)', () => {
    expect(rightPaneProjectId(false, 'grid-proj', 'store-proj')).toBe('store-proj');
  });
});
