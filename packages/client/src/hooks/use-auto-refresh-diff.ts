import { useEffect, useRef } from 'react';
import { useReviewPaneStore } from '@/stores/review-pane-store';

/**
 * Triggers `onRefresh` (debounced) whenever a file-modifying tool call
 * is detected for the given threadId.
 *
 * The debounce uses a trailing-edge strategy: each new dirty signal
 * restarts the timer. This coalesces rapid tool executions (e.g., 10
 * Write calls in 5 seconds) into a single diff fetch.
 */
export function useAutoRefreshDiff(
  threadId: string | undefined,
  onRefresh: () => void,
  debounceMs = 2000
) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  const dirtySignal = useReviewPaneStore((s) => s.dirtySignal);
  const dirtyThreadId = useReviewPaneStore((s) => s.dirtyThreadId);

  useEffect(() => {
    // Only react if the dirty signal is for our thread
    if (!threadId || dirtyThreadId !== threadId || dirtySignal === 0) return;

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
  }, [dirtySignal, dirtyThreadId, threadId, debounceMs]);
}
