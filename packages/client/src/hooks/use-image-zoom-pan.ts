import { useCallback, useRef, useState, type PointerEvent, type WheelEvent } from 'react';

/**
 * Reusable zoom + pan state machine for an `<img>`. Powers both the full-screen
 * `ImageLightbox` and the in-dialog `MediaPreview` image so the two share one
 * behaviour: wheel-to-zoom (cursor-anchored), drag-to-pan, double-click toggle,
 * and a `+`/`-`/`0` control surface exposed for a toolbar.
 *
 * The hook is presentation-agnostic: it returns `imgProps` to spread onto the
 * image and `controls` for a toolbar. Pan offset is clamped to the viewport so
 * the image can never be dragged completely out of sight.
 */

export const MIN_SCALE = 1;
export const MAX_SCALE = 8;
export const BUTTON_ZOOM_FACTOR = 1.4;
/** Pixels the pointer can travel before a press is treated as a pan, not a click. */
const DRAG_THRESHOLD_PX = 4;

export interface Transform {
  scale: number;
  x: number;
  y: number;
}

const IDENTITY: Transform = { scale: 1, x: 0, y: 0 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Keep panning within reach: as the image scales up, allow the offset to grow
 * with it (so every edge stays draggable into view) but never let it fly off so
 * far that the image leaves the viewport entirely.
 */
function clampOffset(t: Transform): Transform {
  if (t.scale <= 1) return { scale: t.scale, x: 0, y: 0 };
  const maxX = ((t.scale - 1) * window.innerWidth) / 2 + window.innerWidth / 4;
  const maxY = ((t.scale - 1) * window.innerHeight) / 2 + window.innerHeight / 4;
  return { scale: t.scale, x: clamp(t.x, -maxX, maxX), y: clamp(t.y, -maxY, maxY) };
}

export interface ImageZoomPan {
  transform: Transform;
  /** True while the image is magnified past fit. */
  zoomed: boolean;
  /** True during an active pointer drag (for cursor styling / disabling transitions). */
  dragging: boolean;
  reset: () => void;
  zoomBy: (factor: number, originX?: number, originY?: number) => void;
  imgProps: {
    draggable: false;
    onWheel: (e: WheelEvent<HTMLImageElement>) => void;
    onPointerDown: (e: PointerEvent<HTMLImageElement>) => void;
    onPointerMove: (e: PointerEvent<HTMLImageElement>) => void;
    onPointerUp: (e: PointerEvent<HTMLImageElement>) => void;
    onDoubleClick: (e: PointerEvent<HTMLImageElement>) => void;
    style: { transform: string };
  };
}

export function useImageZoomPan(): ImageZoomPan {
  const [transform, setTransform] = useState<Transform>(IDENTITY);
  const [dragging, setDragging] = useState(false);

  // Mirror of `transform` so pointer handlers can read the live value
  // synchronously — React nulls the synthetic event before a `setState`
  // updater runs, so the event must be read OUTSIDE the updater.
  const transformRef = useRef<Transform>(IDENTITY);
  const dragStart = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const apply = useCallback((next: Transform) => {
    transformRef.current = next;
    setTransform(next);
  }, []);

  const reset = useCallback(() => apply(IDENTITY), [apply]);

  const zoomBy = useCallback(
    (factor: number, originX?: number, originY?: number) => {
      const t = transformRef.current;
      const nextScale = clamp(t.scale * factor, MIN_SCALE, MAX_SCALE);
      if (nextScale === t.scale) return;
      // Zoom toward the given screen point (cursor); fall back to viewport
      // center. The image is centered, so its center ≈ viewport center.
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      const ux = (originX ?? cx) - cx;
      const uy = (originY ?? cy) - cy;
      const ratio = nextScale / t.scale;
      apply(
        clampOffset({
          scale: nextScale,
          x: ux - ratio * (ux - t.x),
          y: uy - ratio * (uy - t.y),
        }),
      );
    },
    [apply],
  );

  const onWheel = useCallback(
    (e: WheelEvent<HTMLImageElement>) => {
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
    },
    [zoomBy],
  );

  const onPointerDown = useCallback((e: PointerEvent<HTMLImageElement>) => {
    const t = transformRef.current;
    if (t.scale <= 1) return;
    // Read the event synchronously — this must NOT run inside a setState updater.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragStart.current = { x: e.clientX, y: e.clientY, ox: t.x, oy: t.y };
    setDragging(true);
  }, []);

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLImageElement>) => {
      const start = dragStart.current;
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (Math.abs(dx) <= DRAG_THRESHOLD_PX && Math.abs(dy) <= DRAG_THRESHOLD_PX) return;
      apply(clampOffset({ scale: transformRef.current.scale, x: start.ox + dx, y: start.oy + dy }));
    },
    [apply],
  );

  const onPointerUp = useCallback((e: PointerEvent<HTMLImageElement>) => {
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    }
    dragStart.current = null;
    setDragging(false);
  }, []);

  const onDoubleClick = useCallback(
    (e: PointerEvent<HTMLImageElement>) => {
      const t = transformRef.current;
      // Toggle: if already magnified, snap back to fit; otherwise zoom to 2×
      // anchored on the cursor.
      if (t.scale > 1) {
        apply(IDENTITY);
        return;
      }
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      const ux = e.clientX - cx;
      const uy = e.clientY - cy;
      const ratio = 2 / t.scale;
      apply(clampOffset({ scale: 2, x: ux - ratio * (ux - t.x), y: uy - ratio * (uy - t.y) }));
    },
    [apply],
  );

  return {
    transform,
    zoomed: transform.scale > 1,
    dragging,
    reset,
    zoomBy,
    imgProps: {
      draggable: false,
      onWheel,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onDoubleClick,
      style: {
        transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
      },
    },
  };
}
