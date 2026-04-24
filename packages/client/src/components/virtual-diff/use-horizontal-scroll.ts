import { useEffect, useState } from 'react';

/**
 * Single horizontal scrollbar for split/three-pane mode.
 *
 * Uses a CSS custom property `--h-scroll` on the container so all pane text
 * content can apply `translateX(calc(-1 * var(--h-scroll, 0px)))` without
 * React re-renders. A thin native scrollbar at the bottom controls the offset.
 * Horizontal wheel/trackpad gestures on the diff area are also captured.
 */
export function useHorizontalScroll(
  containerRef: React.RefObject<HTMLDivElement | null>,
  hScrollBarRef: React.RefObject<HTMLDivElement | null>,
  enabled: boolean,
  maxTextWidth: number,
) {
  // The spacer inside the scrollbar must be wide enough so that when the user
  // scrolls to the end, the text translateX offset reveals the full line.
  // scrollRange = spacerWidth - scrollBarVisibleWidth
  // We need: scrollRange >= maxTextWidth  →  spacerWidth >= maxTextWidth + scrollBarVisibleWidth
  const [spacerWidth, setSpacerWidth] = useState(0);

  useEffect(() => {
    const scrollBar = hScrollBarRef.current;
    if (!enabled || !scrollBar || maxTextWidth <= 0) {
      setSpacerWidth(0);
      return;
    }
    const update = () => setSpacerWidth(maxTextWidth + scrollBar.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(scrollBar);
    return () => ro.disconnect();
  }, [hScrollBarRef, enabled, maxTextWidth]);

  useEffect(() => {
    const container = containerRef.current;
    const scrollBar = hScrollBarRef.current;
    if (!enabled || !container || !scrollBar) return;

    let syncing = false;

    // Scrollbar → update CSS variable
    const onBarScroll = () => {
      if (syncing) return;
      syncing = true;
      container.style.setProperty('--h-scroll', `${scrollBar.scrollLeft}px`);
      syncing = false;
    };

    // Wheel on diff area → forward horizontal delta to scrollbar
    const onWheel = (e: WheelEvent) => {
      const dx = e.deltaX || (e.shiftKey ? e.deltaY : 0);
      if (dx === 0) return;
      e.preventDefault();
      scrollBar.scrollLeft += dx;
    };

    scrollBar.addEventListener('scroll', onBarScroll, { passive: true });
    container.addEventListener('wheel', onWheel, { passive: false });

    // Reset scroll position
    container.style.setProperty('--h-scroll', '0px');
    scrollBar.scrollLeft = 0;

    return () => {
      scrollBar.removeEventListener('scroll', onBarScroll);
      container.removeEventListener('wheel', onWheel);
      container.style.removeProperty('--h-scroll');
    };
  }, [containerRef, hScrollBarRef, enabled, maxTextWidth]);

  return spacerWidth;
}
