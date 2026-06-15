import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react';

import {
  BUTTON_ZOOM_FACTOR,
  MAX_SCALE,
  MIN_SCALE,
  type ImageZoomPan,
} from '@/hooks/use-image-zoom-pan';
import { cn } from '@/lib/utils';

/**
 * Pill-shaped zoom toolbar shared by the lightbox and the media-preview dialog:
 * zoom out · current % (click to reset) · zoom in · fit-to-screen. Driven by a
 * `useImageZoomPan()` instance so both surfaces behave identically.
 */
export function ImageZoomControls({ zoom, className }: { zoom: ImageZoomPan; className?: string }) {
  const { transform, zoomed, zoomBy, reset } = zoom;
  return (
    <div
      className={cn(
        'flex items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-white backdrop-blur-sm',
        className,
      )}
      onClick={(e) => e.stopPropagation()}
      data-testid="image-zoom-controls"
    >
      <button
        type="button"
        onClick={() => zoomBy(1 / BUTTON_ZOOM_FACTOR)}
        disabled={transform.scale <= MIN_SCALE}
        className="rounded-full p-1.5 transition-colors hover:bg-white/15 disabled:opacity-40"
        aria-label="Zoom out"
        data-testid="image-zoom-out"
      >
        <ZoomOut className="icon-sm" />
      </button>
      <button
        type="button"
        onClick={reset}
        className="min-w-[3.5rem] rounded-full px-2 py-1 text-center text-xs tabular-nums transition-colors hover:bg-white/15"
        aria-label="Reset zoom"
        data-testid="image-zoom-reset"
      >
        {Math.round(transform.scale * 100)}%
      </button>
      <button
        type="button"
        onClick={() => zoomBy(BUTTON_ZOOM_FACTOR)}
        disabled={transform.scale >= MAX_SCALE}
        className="rounded-full p-1.5 transition-colors hover:bg-white/15 disabled:opacity-40"
        aria-label="Zoom in"
        data-testid="image-zoom-in"
      >
        <ZoomIn className="icon-sm" />
      </button>
      <button
        type="button"
        onClick={reset}
        disabled={!zoomed}
        className="rounded-full p-1.5 transition-colors hover:bg-white/15 disabled:opacity-40"
        aria-label="Fit to screen"
        data-testid="image-zoom-fit"
      >
        <Maximize2 className="icon-sm" />
      </button>
    </div>
  );
}
