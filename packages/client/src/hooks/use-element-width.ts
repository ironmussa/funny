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

/**
 * Tracks the viewport-relative left position of a DOM element.
 * Uses getBoundingClientRect() inside a ResizeObserver callback so it
 * updates when the element or its ancestors resize (e.g. panel resizing).
 * Also listens for window resize to catch viewport changes.
 */
export function useElementLeft(ref: RefObject<HTMLElement | null>): number {
  const [left, setLeft] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setLeft(el.getBoundingClientRect().left);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    // Also observe body in case sibling panels resize without changing this element's size
    ro.observe(document.body);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [ref]);

  return left;
}
