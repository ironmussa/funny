import { Check, Code, Image, Maximize2, Minimize2, X, ZoomIn, ZoomOut } from 'lucide-react';
import mermaid from 'mermaid';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useRef, useState } from 'react';

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
import { cn } from '@/lib/utils';

/**
 * Security M1: parse mermaid's SVG output as XML (preserving SVG + XHTML
 * namespaces) and remove the elements/attributes that can carry JS. Mermaid
 * already escapes user input at `securityLevel: 'strict'`, so this is
 * defense-in-depth. We used to delegate to DOMPurify, but its SVG profile
 * stripped HTML content nested inside `<foreignObject>` (which mermaid uses
 * for node labels), leaving every node visually empty.
 */
function sanitizeMermaidSvg(svg: string): string {
  if (!svg) return svg;
  const template = document.createElement('template');
  template.innerHTML = svg;
  const root = template.content;

  root.querySelectorAll('script').forEach((n) => n.remove());
  root.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      else if (
        (name === 'href' || name === 'xlink:href' || name === 'src') &&
        value.startsWith('javascript:')
      ) {
        el.removeAttribute(attr.name);
      }
    }
  });

  const svgEl = root.querySelector('svg');
  return svgEl ? svgEl.outerHTML : '';
}

function useMermaidSvg(chart: string) {
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string>('');
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    let cancelled = false;
    const theme = resolvedTheme === 'monochrome' ? 'default' : 'dark';
    mermaid.initialize({ startOnLoad: false, theme });
    mermaid
      .render(`mermaid-${Math.random().toString(36).slice(2)}`, chart)
      .then(({ svg: renderedSvg }) => {
        if (!cancelled) setSvg(sanitizeMermaidSvg(renderedSvg));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [chart, resolvedTheme]);

  return { svg, error };
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 5;

type PanZoom = {
  containerRef: React.RefObject<HTMLDivElement | null>;
  scale: number;
  offset: { x: number; y: number };
  zoomBy: (factor: number) => void;
  reset: () => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  isDragging: boolean;
};

function clampScale(s: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

function useMermaidPanZoom(): PanZoom {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);

  // Live refs so the native wheel listener always reads current values.
  const scaleRef = useRef(scale);
  const offsetRef = useRef(offset);
  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);
  useEffect(() => {
    offsetRef.current = offset;
  }, [offset]);

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

  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  // Non-passive wheel listener — React's synthetic wheel handler is passive
  // by default, so preventDefault() there is a no-op and the page scrolls
  // along with the zoom gesture. Binding natively fixes that.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - (rect.left + rect.width / 2);
      const my = e.clientY - (rect.top + rect.height / 2);
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      applyZoom(factor, mx, my);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [applyZoom]);

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

const MERMAID_INLINE_HEIGHT = 420;

export function MermaidBlock({ chart }: { chart: string }) {
  const { svg, error } = useMermaidSvg(chart);
  const [expanded, setExpanded] = useState(false);
  const pz = useMermaidPanZoom();

  if (error) {
    return (
      <pre className="overflow-auto rounded bg-red-950/30 p-3 text-xs text-red-400">{error}</pre>
    );
  }

  return (
    <>
      <div
        className="group relative overflow-hidden rounded border border-border bg-card"
        style={{ height: MERMAID_INLINE_HEIGHT }}
        data-testid="mermaid-diagram"
      >
        <div
          ref={pz.containerRef}
          className="absolute inset-0 flex items-center justify-center"
          style={{ cursor: pz.isDragging ? 'grabbing' : 'grab' }}
          onPointerDown={pz.onPointerDown}
          onPointerMove={pz.onPointerMove}
          onPointerUp={pz.onPointerUp}
          onPointerCancel={pz.onPointerUp}
        >
          <div
            className="[&>svg]:max-w-none"
            style={{
              transform: `translate(${pz.offset.x}px, ${pz.offset.y}px) scale(${pz.scale})`,
              transformOrigin: 'center center',
            }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>

        <div className="pointer-events-none absolute right-2 top-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <div className="pointer-events-auto flex items-center gap-1 rounded-md border border-border bg-background/90 px-1 py-0.5 shadow-sm backdrop-blur">
            <span className="px-1 text-xs text-muted-foreground">
              {Math.round(pz.scale * 100)}%
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
                  className="text-xs text-muted-foreground"
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

async function svgToPngBlob(svgHtml: string): Promise<Blob> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgHtml, 'image/svg+xml');
  const svgEl = doc.querySelector('svg');
  const w = svgEl?.getAttribute('width') ? parseFloat(svgEl.getAttribute('width')!) : 800;
  const h = svgEl?.getAttribute('height') ? parseFloat(svgEl.getAttribute('height')!) : 600;

  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);

  const blob = new Blob([svgHtml], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => {
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

export function MermaidExpandedDialog({
  chart,
  open,
  onClose,
}: {
  chart: string;
  open: boolean;
  onClose: () => void;
}) {
  const { svg } = useMermaidSvg(chart);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const pz = useMermaidPanZoom();
  const [copiedCode, copyCode] = useCopyToClipboard();
  const [copiedImage, setCopiedImage] = useState(false);

  useEffect(() => {
    if (open) pz.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleCopyImage = useCallback(async () => {
    if (!svg) return;
    try {
      const pngBlob = await svgToPngBlob(svg);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
      setCopiedImage(true);
      setTimeout(() => setCopiedImage(false), 2000);
    } catch {
      // fallback: ignore if clipboard API not supported
    }
  }, [svg]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className={cn(
          isFullscreen
            ? 'max-w-[100vw] max-h-[100vh] w-[100vw] h-[100vh]'
            : 'w-[90vw] max-w-[1200px] h-[85vh]',
          'flex flex-col gap-0 overflow-hidden p-0',
        )}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader className="flex-shrink-0 border-b border-border px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-sm">Mermaid Diagram</DialogTitle>
          <DialogDescription className="sr-only">Expanded Mermaid diagram view</DialogDescription>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => copyCode(chart)}
                  className="text-muted-foreground"
                  data-testid="mermaid-copy-code"
                >
                  {copiedCode ? <Check className="icon-base" /> : <Code className="icon-base" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{copiedCode ? 'Copied!' : 'Copy code'}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleCopyImage}
                  className="text-muted-foreground"
                  data-testid="mermaid-copy-image"
                >
                  {copiedImage ? <Check className="icon-base" /> : <Image className="icon-base" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{copiedImage ? 'Copied!' : 'Copy as image'}</TooltipContent>
            </Tooltip>
            <div className="mx-1 h-4 w-px bg-border" />
            <span className="mr-1 text-xs text-muted-foreground">
              {Math.round(pz.scale * 100)}%
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => pz.zoomBy(1 / 1.2)}
                  className="text-muted-foreground"
                  data-testid="mermaid-zoom-out"
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
                  data-testid="mermaid-zoom-in"
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
                  className="text-xs text-muted-foreground"
                  data-testid="mermaid-zoom-reset"
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
                  onClick={() => setIsFullscreen((prev) => !prev)}
                  className="text-muted-foreground"
                  data-testid="mermaid-toggle-fullscreen"
                >
                  {isFullscreen ? (
                    <Minimize2 className="icon-base" />
                  ) : (
                    <Maximize2 className="icon-base" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}</TooltipContent>
            </Tooltip>
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
          className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-background"
          style={{ cursor: pz.isDragging ? 'grabbing' : 'grab' }}
          onPointerDown={pz.onPointerDown}
          onPointerMove={pz.onPointerMove}
          onPointerUp={pz.onPointerUp}
          onPointerCancel={pz.onPointerUp}
        >
          <div
            className="[&>svg]:max-w-none"
            style={{
              transform: `translate(${pz.offset.x}px, ${pz.offset.y}px) scale(${pz.scale})`,
              transformOrigin: 'center center',
            }}
            dangerouslySetInnerHTML={{ __html: svg }}
            data-testid="mermaid-expanded-diagram"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
