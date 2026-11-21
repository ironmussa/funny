import { afterEach, beforeEach, describe, expect, test, vi, mock } from 'bun:test';

// Window events must go through jsdom (see the helper).
import { runAllTimersAsync } from '@funny/test-kit';

const loaded: string[] = [];

mock.module('@/components/CommandPalette', () => {
  loaded.push('command-palette');
  return { CommandPalette: () => null };
});
mock.module('@/components/FileSearchDialog', () => {
  loaded.push('file-search');
  return { FileSearchDialog: () => null };
});
mock.module('@/components/AllThreadsView', () => {
  loaded.push('all-threads');
  return { AllThreadsView: () => null };
});
mock.module('@/components/TextSearchDialog', () => {
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
    await runAllTimersAsync();

    expect(loaded).toEqual(['command-palette', 'file-search', 'all-threads', 'text-search']);
  });
});
