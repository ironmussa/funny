import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

/** Start the next page this far before the end of the list comes into view. */
const PRELOAD_MARGIN_PX = 200;

/**
 * Infinite scroll for a paged list: placed after the last row, it calls
 * `onLoadMore` when it scrolls into view and shows a spinner while the page loads.
 *
 * It fires once, then is rebuilt when a load finishes or the row count changes
 * (lists that reveal rows they already hold have no loading phase). A new
 * observer reports the current intersection at once, so a page too short to
 * fill the viewport keeps loading until it does (or `hasMore` turns false).
 * Callers render it only while the list has no error, so a failing page is not
 * retried in a loop.
 *
 * Outside a ScrollArea the root is the viewport; the browser still clips the
 * sentinel by any scrolling ancestor, so plain `overflow-auto` lists work too.
 */
export function LoadMoreSentinel({
  hasMore,
  loading = false,
  itemCount,
  onLoadMore,
  testId,
  className,
}: {
  hasMore: boolean;
  loading?: boolean;
  /** Rows shown so far; a change re-arms the observer. */
  itemCount: number;
  onLoadMore: () => void;
  testId: string;
  className?: string;
}) {
  // A new row count remounts the element (`key` below), which re-arms the observer.
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  // Callers pass a fresh callback each render; a ref keeps the observer from being rebuilt.
  const onLoadMoreRef = useRef(onLoadMore);
  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    if (!el || !hasMore || loading || typeof IntersectionObserver === 'undefined') return;
    // The list scrolls inside a ScrollArea viewport, not the window.
    const root = el.closest<HTMLElement>('[data-radix-scroll-area-viewport]');
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        onLoadMoreRef.current();
      },
      { root, rootMargin: `0px 0px ${PRELOAD_MARGIN_PX}px 0px` },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, hasMore, loading]);

  if (!hasMore) return null;
  return (
    <div
      key={itemCount}
      ref={setEl}
      className={cn('flex justify-center py-2', className)}
      data-testid={testId}
      aria-busy={loading}
    >
      {loading ? <Loader2 className="icon-xs text-muted-foreground animate-spin" /> : null}
    </div>
  );
}
