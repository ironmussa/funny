import { useEffect, useRef, useState, type RefObject } from 'react';

import { browserSessionClient } from '@/lib/browser-session-client';
import {
  BROWSER_SESSION_VIEWPORT_HEIGHT as VIEWPORT_H,
  BROWSER_SESSION_VIEWPORT_WIDTH as VIEWPORT_W,
} from '@/lib/browser-session-viewport';
import { createClientLogger } from '@/lib/client-logger';
import { useBrowserPanelStore, type AnnotationDomInfo } from '@/stores/browser-panel-store';

const THROTTLE_MS = 100;

const log = createClientLogger('browser-session');

interface InspectOverlayProps {
  overlayRef: RefObject<HTMLDivElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
}

/**
 * Inspect mode: while `inspectActive` is on (or the Pin tool is selected),
 * mousemove on the overlay triggers throttled CDP `inspect-at` requests; the
 * resulting element info is displayed as a tooltip near the cursor with a
 * highlight rectangle on the underlying element.
 *
 * - With Inspect on: purely exploratory, no annotations created.
 * - With Pin on: provides the hover preview so the user sees which element
 *   will be captured BEFORE clicking — parity with the Chrome extension's
 *   single hover+click flow. The actual click → annotation is handled by
 *   PinTool; this overlay only renders the highlight + tooltip.
 */
export function InspectOverlay({ overlayRef, canvasRef }: InspectOverlayProps) {
  const inspectActive = useBrowserPanelStore((s) => s.inspectActive);
  const tool = useBrowserPanelStore((s) => s.tool);
  const sessionId = useBrowserPanelStore((s) => s.sessionId);
  const toggleInspectActive = useBrowserPanelStore((s) => s.toggleInspectActive);

  // Active when explicit Inspect mode OR the Pin tool is selected.
  const active = inspectActive || tool === 'pin';

  const [hover, setHover] = useState<{ cx: number; cy: number; info: AnnotationDomInfo } | null>(
    null,
  );
  const lastSent = useRef(0);

  useEffect(() => {
    if (!active) {
      setHover(null);
      return;
    }
    // Escape only toggles explicit Inspect mode — never clears the active
    // tool (that would be surprising while the user is mid-annotation).
    if (!inspectActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') toggleInspectActive();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, inspectActive, toggleInspectActive]);

  useEffect(() => {
    if (!active || !sessionId) return;
    const el = overlayRef.current;
    if (!el) return;

    const onMove = (e: MouseEvent) => {
      const now = Date.now();
      if (now - lastSent.current < THROTTLE_MS) return;
      lastSent.current = now;
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      // Scale to CDP coords against the CANVAS rect, not the overlay's —
      // see toViewportCoords in BrowserViewport.tsx.
      const canvasRect = canvasRef.current?.getBoundingClientRect();
      if (!canvasRect || canvasRect.width === 0 || canvasRect.height === 0) return;
      const vx = Math.round(((e.clientX - canvasRect.left) / canvasRect.width) * VIEWPORT_W);
      const vy = Math.round(((e.clientY - canvasRect.top) / canvasRect.height) * VIEWPORT_H);
      browserSessionClient
        .inspectAt(sessionId, vx, vy)
        .then((info) => {
          if (info && typeof info === 'object') {
            setHover({ cx, cy, info: info as AnnotationDomInfo });
          } else {
            setHover(null);
          }
        })
        .catch((err) => {
          log.debug('inspect mousemove failed', { error: String(err) });
        });
    };

    el.addEventListener('mousemove', onMove);
    return () => el.removeEventListener('mousemove', onMove);
  }, [active, sessionId, overlayRef, canvasRef]);

  if (!active || !hover) return null;

  const rect = overlayRef.current?.getBoundingClientRect();
  if (!rect) return null;

  // Highlight rectangle is in viewport coords → scale back to overlay CSS coords.
  const bb = hover.info.boundingBox;
  const hlLeft = (bb.x / VIEWPORT_W) * rect.width;
  const hlTop = (bb.y / VIEWPORT_H) * rect.height;
  const hlW = (bb.w / VIEWPORT_W) * rect.width;
  const hlH = (bb.h / VIEWPORT_H) * rect.height;

  // Tooltip placement: prefer below + right of cursor; flip if it would clip.
  const tooltipMaxW = 320;
  const tooltipLeft =
    hover.cx + tooltipMaxW + 16 > rect.width ? hover.cx - tooltipMaxW - 8 : hover.cx + 12;
  const tooltipTop = hover.cy + 12;

  return (
    <div
      data-testid="browser-panel-inspect-overlay"
      className="pointer-events-none absolute inset-0"
    >
      <div
        className="border-primary bg-primary/10 absolute border-2"
        style={{ left: hlLeft, top: hlTop, width: hlW, height: hlH }}
      />
      <div
        data-testid="browser-panel-inspect-tooltip"
        className="border-border bg-card absolute max-w-[320px] rounded-md border p-2 text-xs shadow-md"
        style={{ left: tooltipLeft, top: tooltipTop }}
      >
        <div className="text-foreground font-mono">
          {hover.info.tagName.toLowerCase()}
          {hover.info.classes.length > 0 && (
            <span className="text-muted-foreground">
              .{hover.info.classes.slice(0, 3).join('.')}
            </span>
          )}
        </div>
        {hover.info.testid && (
          <div className="text-muted-foreground mt-1">
            <span className="font-mono">data-testid</span>="{hover.info.testid}"
          </div>
        )}
        {hover.info.componentName && (
          <div className="text-muted-foreground mt-1">
            component: <span className="font-mono">{hover.info.componentName}</span>
          </div>
        )}
        <div className="text-muted-foreground mt-1">
          {Math.round(bb.w)} × {Math.round(bb.h)}
        </div>
      </div>
    </div>
  );
}
