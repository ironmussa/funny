import { Maximize2, Minimize2, ZoomIn, ZoomOut } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

import { detectMediaKind, MediaPreview } from '@/components/MediaPreview';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useBoxZoomPan } from '@/hooks/use-box-zoom-pan';
import { isExternalUrl } from '@/lib/raw-file-src';
import { cn } from '@/lib/utils';

interface MediaPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Absolute filesystem path on the runner, or an external `http(s)`/`data` URL. */
  filePath: string | null;
}

export function MediaPreviewDialog({ open, onOpenChange, filePath }: MediaPreviewDialogProps) {
  const fileName = useMemo(() => {
    if (!filePath) return undefined;
    const clean = filePath.split(/[?#]/)[0];
    const idx = clean.lastIndexOf('/');
    return idx === -1 ? clean : clean.slice(idx + 1);
  }, [filePath]);

  const src = useMemo(() => {
    if (!filePath) return null;
    // An external web/data URL loads directly; a local path streams through the
    // runner's raw-file endpoint.
    return isExternalUrl(filePath)
      ? filePath
      : `/api/files/raw?path=${encodeURIComponent(filePath)}`;
  }, [filePath]);

  const kind = useMemo(() => detectMediaKind(fileName), [fileName]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {src &&
        filePath &&
        (kind === 'image' ? (
          <ExpandedImage src={src} name={fileName} />
        ) : (
          <DialogContent
            className="flex max-h-[90vh] w-[90vw] max-w-5xl flex-col gap-3 p-4"
            data-testid="media-preview-dialog"
          >
            <DialogHeader>
              <DialogTitle className="truncate text-sm font-medium">
                {fileName ?? 'Preview'}
              </DialogTitle>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-auto">
              <MediaPreview src={src} name={fileName} />
            </div>
          </DialogContent>
        ))}
    </Dialog>
  );
}

/** Toolbar icon button mirroring the Mermaid expanded-dialog controls. */
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

/**
 * Full-screen image viewer with the toolbar in the dialog HEADER (zoom %, zoom
 * in/out, 1:1 reset, fullscreen) — matching the Mermaid expanded dialog rather
 * than floating controls over the image. Pan/zoom uses the shared container-
 * relative hook; the dialog's built-in close button (from `DialogHeader`) sits
 * alongside the toolbar.
 */
function ExpandedImage({ src, name }: { src: string; name?: string }) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const pz = useBoxZoomPan();
  const zoomed = pz.scale > 1;

  return (
    <DialogContent
      className={cn(
        isFullscreen
          ? 'h-screen max-h-screen w-screen max-w-[100vw]'
          : 'h-[85vh] w-[90vw] max-w-5xl',
        'flex flex-col gap-0 overflow-hidden p-0',
      )}
      onOpenAutoFocus={(e) => e.preventDefault()}
      data-testid="media-preview-dialog"
    >
      <DialogHeader className="border-border shrink-0 border-b px-4 py-3">
        <DialogTitle className="truncate text-sm font-medium">{name ?? 'Preview'}</DialogTitle>
        <DialogDescription className="sr-only">Expanded image view</DialogDescription>
        <div className="flex items-center gap-1">
          <TooltipProvider>
            <span className="text-muted-foreground mr-1 text-xs" data-testid="media-preview-zoom">
              {Math.round(pz.scale * 100)}%
            </span>
            <ToolbarButton
              onClick={() => pz.zoomBy(1 / 1.2)}
              tip="Zoom out"
              testId="media-preview-zoom-out"
            >
              <ZoomOut className="icon-base" />
            </ToolbarButton>
            <ToolbarButton
              onClick={() => pz.zoomBy(1.2)}
              tip="Zoom in"
              testId="media-preview-zoom-in"
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
                  data-testid="media-preview-zoom-reset"
                >
                  1:1
                </Button>
              </TooltipTrigger>
              <TooltipContent>Reset zoom</TooltipContent>
            </Tooltip>
            <ToolbarButton
              onClick={() => setIsFullscreen((p) => !p)}
              tip={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              testId="media-preview-fullscreen"
            >
              {isFullscreen ? (
                <Minimize2 className="icon-base" />
              ) : (
                <Maximize2 className="icon-base" />
              )}
            </ToolbarButton>
          </TooltipProvider>
        </div>
      </DialogHeader>

      <div
        ref={pz.containerRef}
        className="bg-background flex min-h-0 flex-1 items-center justify-center overflow-hidden select-none"
        style={{ cursor: zoomed ? (pz.isDragging ? 'grabbing' : 'grab') : 'default' }}
        onPointerDown={pz.onPointerDown}
        onPointerMove={pz.onPointerMove}
        onPointerUp={pz.onPointerUp}
        onPointerCancel={pz.onPointerUp}
        data-testid="media-preview-image"
      >
        <img
          src={src}
          alt={name ?? 'preview'}
          draggable={false}
          className="max-h-full max-w-full object-contain"
          style={{
            transform: `translate(${pz.offset.x}px, ${pz.offset.y}px) scale(${pz.scale})`,
            transformOrigin: 'center center',
            transition: pz.isDragging ? 'none' : 'transform 120ms',
          }}
        />
      </div>
    </DialogContent>
  );
}
