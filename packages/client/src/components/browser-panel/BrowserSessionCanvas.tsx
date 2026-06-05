import { useEffect, useRef } from 'react';

import {
  BROWSER_SESSION_VIEWPORT_HEIGHT,
  BROWSER_SESSION_VIEWPORT_WIDTH,
  subscribeToFrames,
} from '@/lib/browser-session-frames';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';

/**
 * Renders the runner's JPEG frame stream onto a `<canvas>` sized to the CDP
 * viewport (1920×1080). The canvas is CSS-scaled to fit its container while
 * preserving 16:9 aspect ratio (letterboxed if the panel is taller than 16:9).
 *
 * The parent (`BrowserViewport`) positions the input overlay to match the
 * canvas's display bounds — see `BrowserViewport.tsx` for the click-handling
 * side.
 */
interface BrowserSessionCanvasProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
}

export function BrowserSessionCanvas({ canvasRef }: BrowserSessionCanvasProps) {
  const sessionId = useBrowserPanelStore((s) => s.sessionId);
  const sessionStatus = useBrowserPanelStore((s) => s.sessionStatus);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // Lazily create an Image() instance we reuse for every frame to avoid GC
  // churn at 30 fps.
  useEffect(() => {
    imgRef.current = new Image();
    return () => {
      imgRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = BROWSER_SESSION_VIEWPORT_WIDTH;
    canvas.height = BROWSER_SESSION_VIEWPORT_HEIGHT;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const unsub = subscribeToFrames(sessionId, (base64) => {
      const img = imgRef.current;
      if (!img) return;
      img.onload = () => {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      };
      img.src = `data:image/jpeg;base64,${base64}`;
    });

    return () => {
      unsub();
    };
  }, [sessionId, canvasRef]);

  // The canvas fills its wrapper exactly (no own aspect-ratio / max-* sizing) so
  // its display rect matches the overlay's rect pixel-for-pixel — clicks scale
  // 1:1 to CDP coords without subpixel drift.
  return (
    <canvas
      ref={canvasRef}
      data-testid="browser-panel-canvas"
      data-session-status={sessionStatus}
      className="bg-background block h-full w-full"
      style={{ imageRendering: 'auto' }}
    />
  );
}
