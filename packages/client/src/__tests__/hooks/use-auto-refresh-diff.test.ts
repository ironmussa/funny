import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const reviewPaneState = vi.hoisted(() => ({
  dirtySignal: 0,
  dirtyThreadId: undefined as string | undefined,
}));

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
    expect(nextRefresh).toHaveBeenCalledOnce();
  });
});
