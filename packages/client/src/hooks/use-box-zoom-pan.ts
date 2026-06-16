import { useCallback, useRef, useState, type PointerEvent } from 'react';

/**
 * Container-relative zoom + pan for an inline media box (a chat image card, a
 * diagram, …). Unlike `useImageZoomPan` — which clamps against `window` for the
 * full-screen lightbox — this anchors zoom and pan to the element the
 * `containerRef` is attached to, so it behaves correctly inside a bordered card
 * in the message flow. `scale === 1` is "fit" (the baseline shown as 100%).
 *
 * Mirrors the math used by the inline Mermaid diagram, minus the SVG-specific
 * fit measurement (an `<img>` is already laid out with `object-contain`).
 */

const MIN_SCALE = 1;
const MAX_SCALE = 8;

function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

export interface BoxZoomPan {
  /** Attach to the box that captures wheel/pointer gestures. */
  containerRef: (el: HTMLDivElement | null) => void;
  /** Absolute scale; `1` is fit. Shown to the user as `scale * 100`%. */
  scale: number;
  offset: { x: number; y: number };
  /** Multiply the current scale (e.g. `1.2` to zoom in, `1/1.2` to zoom out). */
  zoomBy: (factor: number) => void;
  /** Back to fit (scale 1, no offset). */
  reset: () => void;
  onPointerDown: (e: PointerEvent) => void;
  onPointerMove: (e: PointerEvent) => void;
  onPointerUp: (e: PointerEvent) => void;
  isDragging: boolean;
}

export function useBoxZoomPan(): BoxZoomPan {
  const wheelCleanupRef = useRef<(() => void) | null>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);

  // Live refs so the native wheel listener and pointer handlers read current
  // values without re-subscribing. Refs may be assigned during render.
  const scaleRef = useRef(scale);
  const offsetRef = useRef(offset);
  scaleRef.current = scale;
  offsetRef.current = offset;

  const dragRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  // Zoom pivoted on (mx, my): pixel coords measured from the container's center.
  // Adjusts the offset so the point under the pivot stays put.
  const applyZoom = useCallback((factor: number, mx: number, my: number) => {
    const prev = scaleRef.current;
    const next = clampScale(prev * factor);
    if (next === prev) return;
    if (next <= 1) {
      setScale(1);
      setOffset({ x: 0, y: 0 });
      return;
    }
    const px = (mx - offsetRef.current.x) / prev;
    const py = (my - offsetRef.current.y) / prev;
    setScale(next);
    setOffset({ x: mx - px * next, y: my - py * next });
  }, []);

  const zoomBy = useCallback((factor: number) => applyZoom(factor, 0, 0), [applyZoom]);

  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  // Callback ref attaches a non-passive wheel listener (it calls preventDefault
  // to stop the page scrolling with the zoom gesture — a synthetic React handler
  // is passive and can't).
  const containerRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (wheelCleanupRef.current) {
        wheelCleanupRef.current();
        wheelCleanupRef.current = null;
      }
      if (!el) return;
      const handler = (e: WheelEvent) => {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const mx = e.clientX - (rect.left + rect.width / 2);
        const my = e.clientY - (rect.top + rect.height / 2);
        applyZoom(e.deltaY > 0 ? 0.9 : 1.1, mx, my);
      };
      // oxlint-disable-next-line react-doctor/client-passive-event-listeners -- intentional non-passive: handler calls preventDefault to suppress page scroll during zoom
      el.addEventListener('wheel', handler, { passive: false });
      wheelCleanupRef.current = () => el.removeEventListener('wheel', handler);
    },
    [applyZoom],
  );

  const onPointerDown = useCallback((e: PointerEvent) => {
    if (e.button !== 0 || scaleRef.current <= 1) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: offsetRef.current.x,
      originY: offsetRef.current.y,
    };
    setIsDragging(true);
  }, []);

  const onPointerMove = useCallback((e: PointerEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setOffset({ x: dragRef.current.originX + dx, y: dragRef.current.originY + dy });
  }, []);

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
    setIsDragging(false);
  }, []);

  return {
    containerRef,
    scale,
    offset,
    zoomBy,
    reset,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    isDragging,
  };
}
