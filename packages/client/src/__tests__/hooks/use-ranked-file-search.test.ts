import { act, renderHook } from '@testing-library/react';
import { errAsync, okAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { useRankedFileSearch } from '@/hooks/use-ranked-file-search';

const { searchFiles } = vi.hoisted(() => ({ searchFiles: vi.fn() }));

vi.mock('@/lib/api', () => ({ api: { searchFiles } }));

const response = {
  matches: [{ path: 'src/app.ts', indices: [4, 5, 6] }],
  total: 1,
  truncated: false,
  basePath: '/repo',
};

beforeEach(() => {
  vi.useFakeTimers();
  searchFiles.mockReturnValue(okAsync(response));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('useRankedFileSearch', () => {
  test('debounces a ranked file search and exposes its result', async () => {
    const { result } = renderHook(() =>
      useRankedFileSearch({
        enabled: true,
        target: { path: '/repo' },
        query: 'app',
        limit: 200,
        debounceMs: 100,
      }),
    );

    expect(result.current.searching).toBe(true);
    expect(searchFiles).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(100));

    expect(searchFiles).toHaveBeenCalledWith(
      { path: '/repo' },
      'app',
      200,
      expect.any(AbortSignal),
    );
    expect(result.current.response).toEqual(response);
    expect(result.current.searching).toBe(false);
  });

  test('cancels the stale request when the query changes', async () => {
    const signals: AbortSignal[] = [];
    searchFiles.mockImplementation((_target, _query, _limit, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise(() => {});
    });

    const { rerender } = renderHook(
      ({ query }) =>
        useRankedFileSearch({
          enabled: true,
          target: { threadId: 'thread-1' },
          query,
          limit: 50,
          debounceMs: 100,
        }),
      { initialProps: { query: 'first' } },
    );

    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(signals[0]?.aborted).toBe(false);

    rerender({ query: 'second' });
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(100));

    expect(searchFiles).toHaveBeenLastCalledWith(
      { threadId: 'thread-1' },
      'second',
      50,
      expect.any(AbortSignal),
    );
  });

  test('exposes a controlled server error without retaining stale results', async () => {
    searchFiles.mockReturnValue(
      errAsync({ type: 'INTERNAL', message: 'File search is unavailable' }),
    );

    const { result } = renderHook(() =>
      useRankedFileSearch({
        enabled: true,
        target: { path: '/repo' },
        query: 'app',
        limit: 200,
        debounceMs: 100,
      }),
    );

    await act(async () => vi.advanceTimersByTimeAsync(100));

    expect(result.current).toEqual({
      response: null,
      searching: false,
      error: 'File search is unavailable',
    });
  });
});
