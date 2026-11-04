import {
  Check,
  Code,
  Download,
  Image,
  Maximize2,
  Minimize2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useCallback, useMemo, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { createClientLogger } from '@/lib/client-logger';
import { cn } from '@/lib/utils';

import { getSvgExportDimensions, inlineForeignObjects, renderThreadDiagram } from './mermaid-utils';

const log = createClientLogger('mermaid');

function useMermaidSvg(chart: string, enabled = true) {
  return useMemo(() => {
    if (!enabled) return { svg: '', error: '' };
    try {
      return { svg: renderThreadDiagram(chart), error: '' };
    } catch (err) {
      return { svg: '', error: err instanceof Error ? err.message : String(err) };
    }
  }, [chart, enabled]);
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 20;

type PanZoom = {
  containerRef: (el: HTMLDivElement | null) => void;
  // Absolute scale — what's applied in the CSS transform. Multiplies the SVG's
  // intrinsic size, so e.g. a tiny diagram fitted to a big container can be
  // scale=10 while looking "correctly sized" to the user.
  scale: number;
  // Display ratio normalized to the fit baseline — 1.0 means "fitted to
  // container". This is what the UI shows as a percentage so the badge reads
  // 100% at fit, not "1000%".
  displayScale: number;
  offset: { x: number; y: number };
  zoomBy: (factor: number) => void;
  reset: () => void;
  fit: () => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  isDragging: boolean;
};

function clampScale(s: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

function useMermaidPanZoom(): PanZoom {
  const containerElRef = useRef<HTMLDivElement | null>(null);
  const wheelCleanupRef = useRef<(() => void) | null>(null);
  const [scale, setScale] = useState(1);
  // The fit-to-container scale, used as the "100%" baseline for the displayed
  // percentage. Updated by fit() — defaults to 1 so the UI doesn't divide by
  // zero before the first measurement.
  const [baselineScale, setBaselineScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);

  // Live refs so the native wheel listener always reads committed values.
  const scaleRef = useRef(scale);
  const offsetRef = useRef(offset);
  useLayoutEffect(() => {
    scaleRef.current = scale;
    offsetRef.current = offset;
  }, [scale, offset]);

  const dragRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  // Apply a zoom factor pivoted on a point within the container (mx, my are
  // pixel coords measured from the container's center). Adjusts offset so the
  // diagram point under the pivot stays in place.
  const applyZoom = useCallback((factor: number, mx: number, my: number) => {
    const prevScale = scaleRef.current;
    const nextScale = clampScale(prevScale * factor);
    if (nextScale === prevScale) return;
    const px = (mx - offsetRef.current.x) / prevScale;
    const py = (my - offsetRef.current.y) / prevScale;
    const nextOffset = { x: mx - px * nextScale, y: my - py * nextScale };
    setScale(nextScale);
    setOffset(nextOffset);
  }, []);

  const zoomBy = useCallback(
    (factor: number) => {
      applyZoom(factor, 0, 0);
    },
    [applyZoom],
  );

  const fit = useCallback(() => {
    const el = containerElRef.current;
    if (!el) return;
    const svg = el.querySelector('svg');
    if (!svg) return;
    const containerW = el.clientWidth;
    const containerH = el.clientHeight;
    let svgW = svg.clientWidth;
    let svgH = svg.clientHeight;
    if (!svgW || !svgH) {
      const widthAttr = svg.getAttribute('width');
      const heightAttr = svg.getAttribute('height');
      svgW = widthAttr ? parseFloat(widthAttr) : 0;
      svgH = heightAttr ? parseFloat(heightAttr) : 0;
    }
    if (!containerW || !containerH || !svgW || !svgH) return;
    const fitScale = clampScale(Math.min(containerW / svgW, containerH / svgH) * 0.95);
    setBaselineScale(fitScale);
    setScale(fitScale);
    setOffset({ x: 0, y: 0 });
  }, []);

  // "1:1" / reset goes back to the fitted view (== 100% in the UI) rather
  // than the SVG's intrinsic size, since the latter is what users perceive
  // as "wrong" when a small diagram opens at e.g. 10% of the dialog.
  const reset = useCallback(() => {
    setScale(baselineScale);
    setOffset({ x: 0, y: 0 });
  }, [baselineScale]);

  // Callback ref: attaches the wheel listener inline so we don't need a
  // useEffect that depends on a containerEl state. The native listener is
  // non-passive because the handler calls preventDefault() to stop the page
  // from scrolling along with the zoom gesture — React's synthetic wheel
  // handler is passive and would no-op preventDefault().
  const containerRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (wheelCleanupRef.current) {
        wheelCleanupRef.current();
        wheelCleanupRef.current = null;
      }
      containerElRef.current = el;
      if (!el) return;
      fit();
      const handler = (e: WheelEvent) => {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const mx = e.clientX - (rect.left + rect.width / 2);
        const my = e.clientY - (rect.top + rect.height / 2);
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        applyZoom(factor, mx, my);
      };
      // The callback ref removes this listener before replacing the node and when React passes null.
      // react-doctor-disable-next-line effect-needs-cleanup
      el.addEventListener('wheel', handler, { passive: false }); // oxlint-disable-line react-doctor/client-passive-event-listeners -- intentional non-passive: handler calls preventDefault to suppress page scroll during zoom
      wheelCleanupRef.current = () => el.removeEventListener('wheel', handler);
    },
    [applyZoom, fit],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        originX: offset.x,
        originY: offset.y,
      };
      setIsDragging(true);
    },
    [offset],
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setOffset({ x: dragRef.current.originX + dx, y: dragRef.current.originY + dy });
  }, []);

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
    setIsDragging(false);
  }, []);

  const displayScale = baselineScale > 0 ? scale / baselineScale : scale;

  return {
    containerRef,
    scale,
    displayScale,
    offset,
    zoomBy,
    reset,
    fit,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    isDragging,
  };
}

const MERMAID_INLINE_HEIGHT = 420;

export function MermaidBlock({ chart }: { chart: string }) {
  const { svg, error } = useMermaidSvg(chart);
  const [expanded, setExpanded] = useState(false);
  const pz = useMermaidPanZoom();
  const { fit } = pz;
  // Memoize the fit-on-mount ref so React only re-attaches when the SVG
  // actually changes — otherwise every render (pan/zoom state change) would
  // refire fit() and reset the user's view.
  const fitOnMount = useCallback(
    (el: HTMLDivElement | null) => {
      if (el && svg) fit();
    },
    [svg, fit],
  );

  if (error) {
    return (
      <div
        className="border-destructive/30 bg-destructive/10 text-destructive flex items-center gap-2 rounded border px-3 py-2 text-xs"
        data-testid="mermaid-error"
      >
        <span className="font-medium">Invalid or unsupported diagram</span>
        <span className="text-muted-foreground">{error}</span>
      </div>
    );
  }

  return (
    <>
      <div
        className="group border-border bg-card relative overflow-hidden rounded border"
        style={{ height: MERMAID_INLINE_HEIGHT }}
        data-testid="mermaid-diagram"
      >
        <div
          ref={pz.containerRef}
          className="absolute inset-0 flex items-center justify-center select-none"
          style={{ cursor: pz.isDragging ? 'grabbing' : 'grab' }}
          onPointerDown={pz.onPointerDown}
          onPointerMove={pz.onPointerMove}
          onPointerUp={pz.onPointerUp}
          onPointerCancel={pz.onPointerUp}
        >
          <div
            key={svg}
            ref={fitOnMount}
            className="[&>svg]:max-w-none"
            style={{
              transform: `translate(${pz.offset.x}px, ${pz.offset.y}px) scale(${pz.scale})`,
              transformOrigin: 'center center',
            }}
            // SVG is sanitized by sanitizeMermaidSvg() (scripts removed,
            // javascript: URLs scrubbed).
            // oxlint-disable-next-line react-doctor/no-danger
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>

        <div className="pointer-events-none absolute top-2 right-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <div className="border-border bg-background/90 pointer-events-auto flex items-center gap-1 rounded-md border px-1 py-0.5 shadow-xs backdrop-blur-sm">
            <span className="text-muted-foreground px-1 text-xs">
              {Math.round(pz.displayScale * 100)}%
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => pz.zoomBy(1 / 1.2)}
                  className="text-muted-foreground"
                  data-testid="mermaid-inline-zoom-out"
                >
                  <ZoomOut className="icon-base" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Zoom out</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => pz.zoomBy(1.2)}
                  className="text-muted-foreground"
                  data-testid="mermaid-inline-zoom-in"
                >
                  <ZoomIn className="icon-base" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Zoom in</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={pz.reset}
                  className="text-muted-foreground text-xs"
                  data-testid="mermaid-inline-zoom-reset"
                >
                  1:1
                </Button>
              </TooltipTrigger>
              <TooltipContent>Reset zoom</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setExpanded(true)}
                  className="text-muted-foreground"
                  data-testid="mermaid-inline-expand"
                >
                  <Maximize2 className="icon-base" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Expand</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>

      <MermaidExpandedDialog chart={chart} open={expanded} onClose={() => setExpanded(false)} />
    </>
  );
}

/** Use fixed light colors so copied images remain readable outside Funny. */
async function renderChartForExport(chart: string): Promise<string> {
  return renderThreadDiagram(chart, 'export');
}

function prepareExportSvg(svgHtml: string): { svgEl: SVGSVGElement; w: number; h: number } {
  // Parse as HTML (matches the sanitizer's input) so we work with the same DOM
  // shape mermaid produced, then re-serialize with XMLSerializer below. The
  // HTML outerHTML serializer drops the xmlns="http://www.w3.org/2000/svg"
  // attribute because it's implicit in HTML context — but when we feed the
  // string back through a blob URL as image/svg+xml, the SVG parser REQUIRES
  // the explicit namespace, otherwise <img> rejects it with "Failed to load
  // SVG image" (the actual error we were seeing in Abbacchio).
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgHtml, 'text/html');
  const svgEl = doc.querySelector('svg');
  if (!svgEl) throw new Error('mermaid output had no <svg> element');
  if (!svgEl.getAttribute('xmlns')) {
    svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  }
  if (!svgEl.getAttribute('xmlns:xlink')) {
    svgEl.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  }
  inlineForeignObjects(svgEl);

  const { w, h } = getSvgExportDimensions(svgEl);

  // Force absolute pixel dimensions in the exported SVG itself. Without this,
  // mermaid's responsive width="100%" makes <img> resolve to a 0×0 (or default
  // 300×150) intrinsic size, and drawImage rasterizes garbage even though we
  // pass explicit w/h.
  svgEl.setAttribute('width', String(w));
  svgEl.setAttribute('height', String(h));

  return { svgEl, w, h };
}

/** Serialize the export SVG as a standalone file (explicit xmlns + pixel size). */
function svgToFileBlob(svgHtml: string): Blob {
  const { svgEl } = prepareExportSvg(svgHtml);
  const serialized = new XMLSerializer().serializeToString(svgEl);
  return new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${serialized}`], {
    type: 'image/svg+xml;charset=utf-8',
  });
}

async function svgToPngBlob(svgHtml: string): Promise<Blob> {
  const { svgEl, w, h } = prepareExportSvg(svgHtml);

  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);

  const serialized = new XMLSerializer().serializeToString(svgEl);
  const blob = new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => {
      // Paint an opaque white background before the SVG so the PNG isn't
      // transparent — otherwise pasting into apps that show whatever's behind
      // (Slack threads, doc backgrounds, dark surfaces) bleeds through.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      canvas.toBlob((pngBlob) => {
        if (pngBlob) resolve(pngBlob);
        else reject(new Error('Failed to create PNG blob'));
      }, 'image/png');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load SVG image'));
    };
    img.src = url;
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Copy-as-PNG and download-as-SVG for a rendered chart. */
function useDiagramExport(chart: string, svg: string) {
  const [copiedImage, setCopiedImage] = useState(false);

  const copyImage = useCallback(async () => {
    if (!svg) return;
    try {
      // Pass the Promise<Blob> directly to ClipboardItem so the user-activation
      // gesture context is preserved across the SVG→PNG conversion. Awaiting
      // the blob first and then calling clipboard.write loses the gesture in
      // Chrome and the write is rejected with NotAllowedError.
      const pngPromise = renderChartForExport(chart).then(svgToPngBlob);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngPromise })]);
      setCopiedImage(true);
      setTimeout(() => setCopiedImage(false), 2000);
      toast.success('Diagram image copied to clipboard');
    } catch (err) {
      log.error('copy-image failed', { error: errorText(err) });
      toast.error('Could not copy image to clipboard');
    }
  }, [chart, svg]);

  const downloadSvg = useCallback(async () => {
    if (!svg) return;
    try {
      downloadBlob(svgToFileBlob(await renderChartForExport(chart)), 'mermaid-diagram.svg');
    } catch (err) {
      log.error('download-svg failed', { error: errorText(err) });
      toast.error('Could not download SVG');
    }
  }, [chart, svg]);

  return { copiedImage, copyImage, downloadSvg };
}

function ToolbarButton({
  label,
  testId,
  onClick,
  className,
  children,
}: {
  label: string;
  testId: string;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClick}
          className={cn('text-muted-foreground', className)}
          data-testid={testId}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function CopyFeedbackIcon({ copied, icon: Icon }: { copied: boolean; icon: typeof Code }) {
  return copied ? (
    <Check className="icon-base copy-feedback-icon text-green-600" />
  ) : (
    <Icon className="icon-base copy-feedback-icon" />
  );
}

export function MermaidExpandedDialog({
  chart,
  open,
  onClose,
}: {
  chart: string;
  open: boolean;
  onClose: () => void;
}) {
  const { svg, error } = useMermaidSvg(chart, open);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const pz = useMermaidPanZoom();
  const [copiedCode, copyCode] = useCopyToClipboard();
  const { copiedImage, copyImage, downloadSvg } = useDiagramExport(chart, svg);
  const { fit } = pz;
  // See MermaidBlock — same memoization rationale. The svg arg is gated on
  // `open` so closing the dialog doesn't refit a stale view.
  const dialogSvg = open ? svg : '';
  const fitOnMount = useCallback(
    (el: HTMLDivElement | null) => {
      if (el && dialogSvg) fit();
    },
    [dialogSvg, fit],
  );

  const handleCopyCode = useCallback(() => {
    copyCode(chart);
  }, [chart, copyCode]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className={cn(
          isFullscreen
            ? 'max-w-[100vw] max-h-screen w-screen h-screen'
            : 'w-[90vw] max-w-[1200px] h-[85vh]',
          'flex flex-col gap-0 overflow-hidden p-0',
        )}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div role="alert" hidden={!error} className="text-destructive px-4 py-2 text-xs">
          Invalid or unsupported diagram: {error}
        </div>
        <DialogHeader className="border-border shrink-0 border-b px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-sm">Mermaid Diagram</DialogTitle>
          <DialogDescription className="sr-only">Expanded Mermaid diagram view</DialogDescription>
          <div className="flex items-center gap-1">
            <ToolbarButton
              label={copiedCode ? 'Copied!' : 'Copy code'}
              testId="mermaid-copy-code"
              onClick={handleCopyCode}
            >
              <CopyFeedbackIcon copied={copiedCode} icon={Code} />
            </ToolbarButton>
            <ToolbarButton
              label={copiedImage ? 'Copied!' : 'Copy as image'}
              testId="mermaid-copy-image"
              onClick={copyImage}
            >
              <CopyFeedbackIcon copied={copiedImage} icon={Image} />
            </ToolbarButton>
            <ToolbarButton label="Download SVG" testId="mermaid-download-svg" onClick={downloadSvg}>
              <Download className="icon-base" />
            </ToolbarButton>
            <div className="bg-border mx-1 h-4 w-px" />
            <span className="text-muted-foreground mr-1 text-xs">
              {Math.round(pz.displayScale * 100)}%
            </span>
            <ToolbarButton
              label="Zoom out"
              testId="mermaid-zoom-out"
              onClick={() => pz.zoomBy(1 / 1.2)}
            >
              <ZoomOut className="icon-base" />
            </ToolbarButton>
            <ToolbarButton label="Zoom in" testId="mermaid-zoom-in" onClick={() => pz.zoomBy(1.2)}>
              <ZoomIn className="icon-base" />
            </ToolbarButton>
            <ToolbarButton
              label="Reset zoom"
              testId="mermaid-zoom-reset"
              onClick={pz.reset}
              className="text-xs"
            >
              1:1
            </ToolbarButton>
            <ToolbarButton
              label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              testId="mermaid-toggle-fullscreen"
              onClick={() => setIsFullscreen((prev) => !prev)}
            >
              {isFullscreen ? (
                <Minimize2 className="icon-base" />
              ) : (
                <Maximize2 className="icon-base" />
              )}
            </ToolbarButton>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              className="text-muted-foreground"
              data-testid="mermaid-close"
            >
              <X className="icon-base" />
            </Button>
          </div>
        </DialogHeader>

        <div
          ref={pz.containerRef}
          className="bg-background flex min-h-0 flex-1 items-center justify-center overflow-hidden select-none"
          style={{ cursor: pz.isDragging ? 'grabbing' : 'grab' }}
          onPointerDown={pz.onPointerDown}
          onPointerMove={pz.onPointerMove}
          onPointerUp={pz.onPointerUp}
          onPointerCancel={pz.onPointerUp}
        >
          <div
            key={dialogSvg}
            ref={fitOnMount}
            className="[&>svg]:max-w-none"
            style={{
              transform: `translate(${pz.offset.x}px, ${pz.offset.y}px) scale(${pz.scale})`,
              transformOrigin: 'center center',
            }}
            // SVG is sanitized by sanitizeMermaidSvg() and mermaid runs at
            // SVG output is sanitized before insertion.
            // oxlint-disable-next-line react-doctor/no-danger
            dangerouslySetInnerHTML={{ __html: svg }}
            data-testid="mermaid-expanded-diagram"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
