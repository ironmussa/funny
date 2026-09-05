import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const loaded: string[] = [];

vi.mock('@/components/CommandPalette', () => {
  loaded.push('command-palette');
  return { CommandPalette: () => null };
});
vi.mock('@/components/FileSearchDialog', () => {
  loaded.push('file-search');
  return { FileSearchDialog: () => null };
});
vi.mock('@/components/AllThreadsView', () => {
  loaded.push('all-threads');
  return { AllThreadsView: () => null };
});
vi.mock('@/components/TextSearchDialog', () => {
  loaded.push('text-search');
  return { TextSearchDialog: () => null };
});

import { scheduleShortcutTargetPreloads } from '@/platform/shortcut-target-preloads';

describe('scheduleShortcutTargetPreloads', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('warms shortcut targets sequentially during idle time', async () => {
    scheduleShortcutTargetPreloads();

    expect(loaded).toEqual([]);
    window.dispatchEvent(new Event('load'));
    await vi.runAllTimersAsync();

    expect(loaded).toEqual(['command-palette', 'file-search', 'all-threads', 'text-search']);
  });
});
