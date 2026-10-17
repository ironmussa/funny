import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * Tracks the pixel width of a DOM element via ResizeObserver.
 * Uses useLayoutEffect so the measurement happens before paint,
 * preventing a flash of incorrect overlay positioning.
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  return width;
}
