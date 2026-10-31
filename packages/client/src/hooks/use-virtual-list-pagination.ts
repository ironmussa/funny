import { useEffect } from 'react';

const LOAD_MORE_THRESHOLD = 5;

export function useVirtualListPagination(
  virtualItems: ReadonlyArray<{ index: number }>,
  count: number,
  hasMore?: boolean,
  loadingMore?: boolean,
  onEndReached?: () => void,
) {
  useEffect(() => {
    if (!hasMore || loadingMore || !onEndReached) return;
    const last = virtualItems.at(-1);
    if (last && last.index >= count - 1 - LOAD_MORE_THRESHOLD) onEndReached();
  }, [virtualItems, count, hasMore, loadingMore, onEndReached]);
}
