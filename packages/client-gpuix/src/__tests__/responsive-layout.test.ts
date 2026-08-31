import { describe, expect, test } from 'bun:test';

import {
  COMPACT_WINDOW_MAX_WIDTH,
  FILE_TREE_DEFAULT_MIN_WIDTH,
  resolveFileTreeVisibility,
  resolveSidebarVisibility,
} from '../responsive-layout';

describe('native responsive layout', () => {
  test('hides the sidebar automatically in compact windows', () => {
    expect(resolveSidebarVisibility(COMPACT_WINDOW_MAX_WIDTH, null)).toBe(false);
    expect(resolveSidebarVisibility(COMPACT_WINDOW_MAX_WIDTH + 1, null)).toBe(true);
  });

  test('honors a manual visibility override at either width', () => {
    expect(resolveSidebarVisibility(400, true)).toBe(true);
    expect(resolveSidebarVisibility(1_400, false)).toBe(false);
  });

  test('shows the file tree by default only when three docks fit', () => {
    expect(resolveFileTreeVisibility(FILE_TREE_DEFAULT_MIN_WIDTH - 1, null)).toBe(false);
    expect(resolveFileTreeVisibility(FILE_TREE_DEFAULT_MIN_WIDTH, null)).toBe(true);
    expect(resolveFileTreeVisibility(700, true)).toBe(true);
    expect(resolveFileTreeVisibility(1_400, false)).toBe(false);
  });
});
