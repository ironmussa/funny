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
 * Hook that renders a mermaid chart string into SVG html.
 */
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
        if (!cancelled) setSvg(renderedSvg);
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

/**
 * Renders a Mermaid diagram inline (no expand button — that lives in the code-block wrapper).
 */
export function MermaidBlock({ chart }: { chart: string }) {
  const { svg, error } = useMermaidSvg(chart);

  if (error) {
    return (
      <pre className="overflow-auto rounded bg-red-950/30 p-3 text-xs text-red-400">{error}</pre>
    );
  }

  return (
    <div
      className="flex justify-center [&>svg]:max-w-full"
      data-testid="mermaid-diagram"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/**
 * Converts an SVG string to a PNG blob via an offscreen canvas.
 */
async function svgToPngBlob(svgHtml: string): Promise<Blob> {
  // Parse to extract width/height from the SVG element
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgHtml, 'image/svg+xml');
  const svgEl = doc.querySelector('svg');
  const w = svgEl?.getAttribute('width') ? parseFloat(svgEl.getAttribute('width')!) : 800;
  const h = svgEl?.getAttribute('height') ? parseFloat(svgEl.getAttribute('height')!) : 600;

  const scale = 2; // 2x for retina
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

/**
 * Fullscreen dialog for viewing a Mermaid diagram with zoom + pan controls.
 */
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
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [copiedCode, copyCode] = useCopyToClipboard();
  const [copiedImage, setCopiedImage] = useState(false);

  // Reset state when opening
  useEffect(() => {
    if (open) {
      setScale(1);
      setOffset({ x: 0, y: 0 });
    }
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

  // Zoom with mouse wheel
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setScale((prev) => {
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      return Math.min(5, Math.max(0.2, prev + delta));
    });
  }, []);

  // Drag to pan
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return; // left click only
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        originX: offset.x,
        originY: offset.y,
      };
    },
    [offset],
  );

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setOffset({ x: dragRef.current.originX + dx, y: dragRef.current.originY + dy });
  }, []);

  const handlePointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

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
            {/* Copy code */}
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
            {/* Copy image */}
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
            {/* Separator */}
            <div className="mx-1 h-4 w-px bg-border" />
            <span className="mr-1 text-xs text-muted-foreground">{Math.round(scale * 100)}%</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setScale((s) => Math.max(0.2, s - 0.2))}
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
                  onClick={() => setScale((s) => Math.min(5, s + 0.2))}
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
                  onClick={() => {
                    setScale(1);
                    setOffset({ x: 0, y: 0 });
                  }}
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
          ref={containerRef}
          className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-background"
          style={{ cursor: dragRef.current ? 'grabbing' : 'grab' }}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <div
            className="[&>svg]:max-w-none"
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
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
