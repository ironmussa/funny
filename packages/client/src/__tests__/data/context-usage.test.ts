import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';

import type { ContextBreakdown } from '@funny/shared';

import {
  applyContextUsageEvent,
  getContextUsageStore,
  resetContextUsage,
  restoreContextUsage,
} from '@/data/context-usage/store';

import { installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

const breakdown: ContextBreakdown = {
  totalTokens: 12_000,
  maxTokens: 200_000,
  percentage: 6,
  model: 'claude-opus-5-5',
  categories: [{ id: 'messages', name: 'Messages', tokens: 12_000, kind: 'used' }],
  mcpServers: [],
  memoryFiles: [],
  capturedAt: '2026-11-09T00:00:00.000Z',
};

const read = (threadId: string) => getContextUsageStore().read(threadId);

beforeEach(() => {
  installTestDataLayer();
});
afterEach(() => resetTestDataLayer());

describe('context-usage collection', () => {
  test('applies a usage event and returns the row it wrote', () => {
    const written = applyContextUsageEvent('t1', {
      inputTokens: 40,
      outputTokens: 20,
      cumulativeInputTokens: 100,
    });

    const expected = { cumulativeInputTokens: 100, lastInputTokens: 40, lastOutputTokens: 20 };
    expect(written).toEqual(expected);
    expect(read('t1')).toMatchObject(expected);
  });

  test('keeps the last breakdown across per-message events that carry none', () => {
    applyContextUsageEvent('t1', {
      inputTokens: 12_000,
      outputTokens: 0,
      cumulativeInputTokens: 12_000,
      breakdown,
    });
    applyContextUsageEvent('t1', {
      inputTokens: 13_000,
      outputTokens: 50,
      cumulativeInputTokens: 13_000,
    });

    expect(read('t1')?.cumulativeInputTokens).toBe(13_000);
    expect(read('t1')?.breakdown).toEqual(breakdown);
  });

  test('a compaction resets usage to the post-compaction size and drops the breakdown', () => {
    applyContextUsageEvent('t1', {
      inputTokens: 150_000,
      outputTokens: 0,
      cumulativeInputTokens: 150_000,
      breakdown,
    });
    resetContextUsage('t1', 32_000);

    expect(read('t1')).toMatchObject({
      cumulativeInputTokens: 32_000,
      lastInputTokens: 32_000,
      lastOutputTokens: 0,
    });
    expect(read('t1')?.breakdown).toBeUndefined();
  });

  test('restores a persisted snapshot only when the session has no row', () => {
    const snapshot = { cumulativeInputTokens: 500, lastInputTokens: 500, lastOutputTokens: 0 };
    restoreContextUsage('t1', () => snapshot);
    expect(read('t1')?.cumulativeInputTokens).toBe(500);

    applyContextUsageEvent('t2', { inputTokens: 9, outputTokens: 0, cumulativeInputTokens: 9 });
    const load = vi.fn(() => snapshot);
    restoreContextUsage('t2', load);
    expect(load).not.toHaveBeenCalled();
    expect(read('t2')?.cumulativeInputTokens).toBe(9);
  });

  test('a new session starts empty', () => {
    applyContextUsageEvent('t1', { inputTokens: 1, outputTokens: 0, cumulativeInputTokens: 1 });
    installTestDataLayer('user-2');
    expect(read('t1')).toBeUndefined();
  });

  test('keeps the reported window across events of the same run', () => {
    applyContextUsageEvent('t1', {
      inputTokens: 10,
      outputTokens: 0,
      cumulativeInputTokens: 10,
      provider: 'antigravity',
      model: 'gemini-3-pro',
      maxTokens: 1_048_576,
    });
    applyContextUsageEvent('t1', { inputTokens: 20, outputTokens: 0, cumulativeInputTokens: 20 });

    expect(read('t1')).toMatchObject({
      provider: 'antigravity',
      model: 'gemini-3-pro',
      maxTokens: 1_048_576,
      cumulativeInputTokens: 20,
    });
  });

  test('drops the breakdown and window of another provider', () => {
    applyContextUsageEvent('t1', {
      inputTokens: 12_000,
      outputTokens: 0,
      cumulativeInputTokens: 12_000,
      provider: 'claude',
      maxTokens: 200_000,
      breakdown,
    });
    applyContextUsageEvent('t1', {
      inputTokens: 5_000,
      outputTokens: 0,
      cumulativeInputTokens: 5_000,
      provider: 'antigravity',
    });

    expect(read('t1')?.provider).toBe('antigravity');
    expect(read('t1')?.breakdown).toBeUndefined();
    expect(read('t1')?.maxTokens).toBeUndefined();
  });

  test('a compaction keeps the run provider and window', () => {
    applyContextUsageEvent('t1', {
      inputTokens: 900_000,
      outputTokens: 0,
      cumulativeInputTokens: 900_000,
      provider: 'antigravity',
      maxTokens: 1_048_576,
    });
    resetContextUsage('t1', 40_000);

    expect(read('t1')).toMatchObject({
      cumulativeInputTokens: 40_000,
      provider: 'antigravity',
      maxTokens: 1_048_576,
    });
  });
});
