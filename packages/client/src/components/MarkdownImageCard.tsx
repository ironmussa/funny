import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { MediaLoadError } from '@/components/MediaLoadError';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useBoxZoomPan } from '@/hooks/use-box-zoom-pan';
import { useMediaPreviewStore } from '@/stores/media-preview-store';

/** Inline box height — mirrors the Mermaid diagram card so the two read alike. */
const IMAGE_CARD_HEIGHT = 360;

/** Derive a display filename from a local path or a web URL (drops any query). */
function fileNameOf(src: string): string {
  const clean = src.split(/[?#]/)[0];
  const idx = clean.lastIndexOf('/');
  return idx === -1 ? clean : clean.slice(idx + 1);
}

function ToolbarButton({
  onClick,
  tip,
  testId,
  children,
}: {
  onClick: () => void;
  tip: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClick}
          className="text-muted-foreground"
          data-testid={testId}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

export interface MarkdownImageCardProps {
  /** Resolved URL the `<img>` loads (proxied/signed for local, passthrough for web). */
  src: string;
  /** Original path/URL — used for the filename header, the lightbox, and error context. */
  originalSrc?: string;
  alt?: string;
  title?: string;
  /**
   * From `useResolvedMediaSrc`: on an `<img>` error, attempts a signed→proxied
   * fallback. Returns true when it recovered (retry), false for a real failure.
   */
  onMediaError: () => boolean;
}

/**
 * Chat image rendered with the same chrome as the inline Mermaid diagram: a
 * bordered card with a filename header and a hover toolbar (zoom %, zoom in/out,
 * 1:1 reset, expand). Pan/zoom happens inside the box; "expand" opens the
 * shared media lightbox for a full-screen view. On load failure it shows the
 * shared `MediaLoadError` instead of a broken-image glyph.
 */
export function MarkdownImageCard({
  src,
  originalSrc,
  alt,
  title,
  onMediaError,
}: MarkdownImageCardProps) {
  const [failed, setFailed] = useState(false);
  // Retry cleanly when the resolved source changes (e.g. signed→proxied fallback).
  useEffect(() => setFailed(false), [src]);
  const pz = useBoxZoomPan();

  const name = useMemo(() => (originalSrc ? fileNameOf(originalSrc) : ''), [originalSrc]);

  if (failed) {
    return (
      <div className="my-2">
        <MediaLoadError probeUrl={src} path={originalSrc} />
      </div>
    );
  }

  const zoomed = pz.scale > 1;

  return (
    <div
      className="group border-border bg-card relative my-2 overflow-hidden rounded border"
      data-testid="markdown-image-card"
    >
      {name && (
        <div
          className="text-muted-foreground/80 border-border truncate border-b px-3 py-1.5 text-xs"
          data-testid="markdown-image-name"
        >
          {name}
        </div>
      )}
      <div
        ref={pz.containerRef}
        className="bg-muted/20 relative flex items-center justify-center overflow-hidden select-none"
        style={{
          height: IMAGE_CARD_HEIGHT,
          cursor: zoomed ? (pz.isDragging ? 'grabbing' : 'grab') : 'default',
        }}
        onPointerDown={pz.onPointerDown}
        onPointerMove={pz.onPointerMove}
        onPointerUp={pz.onPointerUp}
        onPointerCancel={pz.onPointerUp}
      >
        <img
          src={src}
          alt={alt ?? ''}
          title={title}
          loading="lazy"
          draggable={false}
          data-testid="markdown-image"
          onError={() => {
            if (!onMediaError()) setFailed(true);
          }}
          className="max-h-full max-w-full object-contain"
          style={{
            transform: `translate(${pz.offset.x}px, ${pz.offset.y}px) scale(${pz.scale})`,
            transformOrigin: 'center center',
            transition: pz.isDragging ? 'none' : 'transform 120ms',
          }}
        />

        <TooltipProvider>
          <div className="pointer-events-none absolute top-2 right-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <div className="border-border bg-background/90 pointer-events-auto flex items-center gap-1 rounded-md border px-1 py-0.5 shadow-xs backdrop-blur-sm">
              <span
                className="text-muted-foreground px-1 text-xs"
                data-testid="markdown-image-zoom"
              >
                {Math.round(pz.scale * 100)}%
              </span>
              <ToolbarButton
                onClick={() => pz.zoomBy(1 / 1.2)}
                tip="Zoom out"
                testId="markdown-image-zoom-out"
              >
                <ZoomOut className="icon-base" />
              </ToolbarButton>
              <ToolbarButton
                onClick={() => pz.zoomBy(1.2)}
                tip="Zoom in"
                testId="markdown-image-zoom-in"
              >
                <ZoomIn className="icon-base" />
              </ToolbarButton>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={pz.reset}
                    className="text-muted-foreground text-xs"
                    data-testid="markdown-image-zoom-reset"
                  >
                    1:1
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Reset zoom</TooltipContent>
              </Tooltip>
              <ToolbarButton
                onClick={() => originalSrc && useMediaPreviewStore.getState().open(originalSrc)}
                tip="Expand"
                testId="markdown-image-expand"
              >
                <Maximize2 className="icon-base" />
              </ToolbarButton>
            </div>
          </div>
        </TooltipProvider>
      </div>
    </div>
  );
}
