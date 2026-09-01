import { useEffect, useLayoutEffect, useRef } from 'react';

import { useReviewPaneStore } from '@/stores/review-pane-store';

/**
 * Triggers `onRefresh` (debounced) whenever a file-modifying tool call
 * is detected for the given threadId.
 *
 * The debounce uses a trailing-edge strategy: each new dirty signal
 * restarts the timer. This coalesces rapid tool executions (e.g., 10
 * Write calls in 5 seconds) into a single diff fetch.
 *
 * When `isVisible` is false (pane hidden), dirty signals are tracked
 * but the timer is not started. Instead, a pending flag is set so that
 * the next time the pane becomes visible, the refresh fires immediately.
 */
export function useAutoRefreshDiff(
  threadId: string | undefined,
  onRefresh: () => void,
  debounceMs = 1000,
  isVisible = true,
) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onRefreshRef = useRef(onRefresh);
  useLayoutEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);
  const pendingWhileHiddenRef = useRef(false);

  const dirtySignal = useReviewPaneStore((s) => s.dirtySignal);
  const dirtyThreadId = useReviewPaneStore((s) => s.dirtyThreadId);

  useEffect(() => {
    // Only react if the dirty signal is for our thread
    if (!threadId || dirtyThreadId !== threadId || dirtySignal === 0) return;

    // If the pane is hidden, just mark as pending for when it becomes visible
    if (!isVisible) {
      pendingWhileHiddenRef.current = true;
      return;
    }

    // Clear any existing timer (restart debounce on each new signal)
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      onRefreshRef.current();
    }, debounceMs);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [dirtySignal, dirtyThreadId, threadId, debounceMs, isVisible]);

  // When the pane becomes visible with a pending refresh, fire immediately
  useEffect(() => {
    if (isVisible && pendingWhileHiddenRef.current) {
      pendingWhileHiddenRef.current = false;
      onRefreshRef.current();
    }
  }, [isVisible]);
}
