import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import { useElementWidth } from '@/hooks/use-element-width';
import { graphGutterViewportWidth } from '@/lib/commit-graph-layout';

/** Marks a row's lane gutter: a wheel over it scrolls the lanes sideways. */
export const GRAPH_GUTTER_WHEEL_ATTR = 'data-graph-gutter';

/**
 * Horizontal scroll of the lane gutter when it is wider than its viewport: the
 * clamped scroll offset shared by every row, the scrollbar it syncs with, and
 * the wheel handling (horizontal wheel, or shift + vertical wheel, over an
 * element carrying `GRAPH_GUTTER_WHEEL_ATTR`).
 *
 * The wheel listener is a native one on the root, registered with
 * `passive: false`: React registers `onWheel` as passive, so its
 * `preventDefault()` is refused (a console error on every wheel tick) and the
 * list would scroll along with the lanes.
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
    (event: WheelEvent) => {
      if (graphMaxScrollLeft <= 0) return;
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest(`[${GRAPH_GUTTER_WHEEL_ATTR}]`)) return;
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
  // No dependency list: the root mounts only once the tab has a git context,
  // so the listener is bound again to whatever element the ref holds after
  // each render (adding and removing one listener is cheap).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.addEventListener('wheel', handleGraphGutterWheel, { passive: false });
    return () => root.removeEventListener('wheel', handleGraphGutterWheel);
  });

  return {
    graphHorizontalScrollRef,
    graphViewportWidth,
    graphMaxScrollLeft,
    clampedGraphScrollLeft,
    updateGraphScrollLeft,
  };
}
