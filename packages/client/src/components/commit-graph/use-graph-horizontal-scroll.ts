import { useCallback, useRef, useState, type RefObject, type WheelEvent } from 'react';

import { useElementWidth } from '@/hooks/use-element-width';
import { graphGutterViewportWidth } from '@/lib/commit-graph-layout';

/**
 * Horizontal scroll of the lane gutter when it is wider than its viewport: the
 * clamped scroll offset shared by every row, the scrollbar it syncs with, and
 * the wheel handler (horizontal wheel, or shift + vertical wheel).
 */
export function useGraphHorizontalScroll(
  rootRef: RefObject<HTMLDivElement | null>,
  gutterWidth: number,
) {
  const [graphScrollLeft, setGraphScrollLeft] = useState(0);
  const graphScrollLeftRef = useRef(0);
  const graphHorizontalScrollRef = useRef<HTMLDivElement>(null);
  const rootWidth = useElementWidth(rootRef);
  const graphViewportWidth = graphGutterViewportWidth(gutterWidth, rootWidth);
  const graphMaxScrollLeft = Math.max(0, gutterWidth - graphViewportWidth);
  const clampedGraphScrollLeft = Math.min(graphScrollLeft, graphMaxScrollLeft);
  const updateGraphScrollLeft = useCallback(
    (nextScrollLeft: number) => {
      const clampedScrollLeft = Math.max(0, Math.min(graphMaxScrollLeft, nextScrollLeft));
      const scrollElement = graphHorizontalScrollRef.current;
      if (scrollElement && Math.round(scrollElement.scrollLeft) !== Math.round(clampedScrollLeft)) {
        scrollElement.scrollLeft = clampedScrollLeft;
      }
      graphScrollLeftRef.current = clampedScrollLeft;
      setGraphScrollLeft(clampedScrollLeft);
    },
    [graphMaxScrollLeft],
  );
  const handleGraphGutterWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      if (graphMaxScrollLeft <= 0) return;
      const delta =
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
          ? event.deltaX
          : event.shiftKey
            ? event.deltaY
            : 0;
      if (delta === 0) return;
      event.preventDefault();
      updateGraphScrollLeft(graphScrollLeftRef.current + delta);
    },
    [graphMaxScrollLeft, updateGraphScrollLeft],
  );

  return {
    graphHorizontalScrollRef,
    graphViewportWidth,
    graphMaxScrollLeft,
    clampedGraphScrollLeft,
    updateGraphScrollLeft,
    handleGraphGutterWheel,
  };
}
