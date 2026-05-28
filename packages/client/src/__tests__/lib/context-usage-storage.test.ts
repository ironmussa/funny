import { beforeEach, describe, expect, test } from 'vitest';

import { emitContextUsage } from '@/lib/context-usage-events';
import { loadContextUsage, saveContextUsage } from '@/lib/context-usage-storage';

describe('context-usage-storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('round-trips context usage for a thread', () => {
    const usage = {
      cumulativeInputTokens: 100,
      lastInputTokens: 40,
      lastOutputTokens: 20,
    };

    saveContextUsage('thread-1', usage);

    expect(loadContextUsage('thread-1')).toEqual(usage);
  });

  test('returns undefined for missing or invalid entries', () => {
    expect(loadContextUsage('missing')).toBeUndefined();
    localStorage.setItem('funny:contextUsage:bad', '{not-json');
    expect(loadContextUsage('bad')).toBeUndefined();
  });

  test('expires entries older than seven days', () => {
    const key = 'funny:contextUsage:old';
    localStorage.setItem(
      key,
      JSON.stringify({
        cumulativeInputTokens: 10,
        lastInputTokens: 5,
        lastOutputTokens: 2,
        savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
      }),
    );

    expect(loadContextUsage('old')).toBeUndefined();
    expect(localStorage.getItem(key)).toBeNull();
  });

  test('persists usage when emitContextUsage fires', () => {
    emitContextUsage('thread-2', {
      cumulativeInputTokens: 50,
      lastInputTokens: 10,
      lastOutputTokens: 5,
    });

    expect(loadContextUsage('thread-2')).toEqual({
      cumulativeInputTokens: 50,
      lastInputTokens: 10,
      lastOutputTokens: 5,
    });
  });
});
