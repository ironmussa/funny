import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';

import { act, renderHook } from '@testing-library/react';

interface ReviewPaneMockState {
  dirtySignal: number;
  dirtyThreadId: string | undefined;
}

const reviewPaneState = ((): ReviewPaneMockState => ({
  dirtySignal: 0,
  dirtyThreadId: undefined,
}))();

vi.mock('@/stores/review-pane-store', () => ({
  useReviewPaneStore: (selector: (state: typeof reviewPaneState) => unknown) =>
    selector(reviewPaneState),
}));

import { useAutoRefreshDiff } from '@/hooks/use-auto-refresh-diff';

describe('useAutoRefreshDiff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reviewPaneState.dirtySignal = 0;
    reviewPaneState.dirtyThreadId = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('uses the latest committed refresh callback when the debounce fires', () => {
    const initialRefresh = vi.fn();
    const nextRefresh = vi.fn();
    const { rerender } = renderHook(
      ({ onRefresh }: { onRefresh: () => void }) => useAutoRefreshDiff('thread-1', onRefresh, 100),
      { initialProps: { onRefresh: initialRefresh } },
    );

    reviewPaneState.dirtySignal = 1;
    reviewPaneState.dirtyThreadId = 'thread-1';
    rerender({ onRefresh: nextRefresh });
    act(() => vi.advanceTimersByTime(100));

    expect(initialRefresh).not.toHaveBeenCalled();
    expect(nextRefresh).toHaveBeenCalledTimes(1);
  });
});
