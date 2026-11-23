import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef } from 'react';

import type { GraphEntry } from '@/components/commit-graph/graph-entry';

/**
 * The virtualizer over the displayed commit rows (plus the load-more sentinel
 * row), re-measured when the row heights change, paging in more history as
 * the sentinel comes into view.
 */
export function useGraphVirtualizer({
  displayEntries,
  loadedCount,
  showSentinel,
  baseRowH,
  refsRowH,
  rowHeightFor,
  loadMore,
}: {
  displayEntries: GraphEntry[];
  /** How many commits are loaded (filtered or not); drives the sentinel. */
  loadedCount: number;
  showSentinel: boolean;
  baseRowH: number;
  refsRowH: number;
  rowHeightFor: (entry: GraphEntry) => number;
  loadMore: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowCount = displayEntries.length + (showSentinel ? 1 : 0);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      index >= displayEntries.length ? baseRowH : rowHeightFor(displayEntries[index]),
    getItemKey: (index) =>
      index >= displayEntries.length ? '__sentinel__' : displayEntries[index].hash,
    overscan: 12,
  });

  // Re-measure when the row heights change (font-size setting toggled).
  useEffect(() => {
    virtualizer.measure();
  }, [baseRowH, refsRowH, virtualizer]);

  const virtualItems = virtualizer.getVirtualItems();
  const lastIndex = virtualItems[virtualItems.length - 1]?.index;
  useEffect(() => {
    if (!showSentinel || lastIndex === undefined) return;
    if (lastIndex >= loadedCount - 5) loadMore();
  }, [lastIndex, loadedCount, showSentinel, loadMore]);

  return { scrollRef, virtualizer, virtualItems };
}
