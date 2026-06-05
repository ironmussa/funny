import { useEffect, useRef } from 'react';

import { browserSessionClient } from '@/lib/browser-session-client';
import {
  BROWSER_SESSION_ASPECT_RATIO,
  BROWSER_SESSION_VIEWPORT_HEIGHT,
  BROWSER_SESSION_VIEWPORT_WIDTH,
} from '@/lib/browser-session-frames';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';

import { BrowserSessionCanvas } from './BrowserSessionCanvas';
import { InspectOverlay } from './InspectOverlay';
import { TestIdOverlay } from './TestIdOverlay';
import { DrawTool } from './tools/DrawTool';
import { PinTool } from './tools/PinTool';
import { RegionTool } from './tools/RegionTool';

export function BrowserViewport() {
  const loadedUrl = useBrowserPanelStore((s) => s.loadedUrl);
  const tool = useBrowserPanelStore((s) => s.tool);
  const setLoadError = useBrowserPanelStore((s) => s.setLoadError);
  const overlaysVisible = useBrowserPanelStore((s) => s.overlaysVisible);
  const sessionId = useBrowserPanelStore((s) => s.sessionId);
  const sessionStatus = useBrowserPanelStore((s) => s.sessionStatus);
  const inspectActive = useBrowserPanelStore((s) => s.inspectActive);

  const overlayRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Heartbeat: keep the runner session alive while the viewport is mounted.
  // The runner reaps sessions idle for >90s (see HEARTBEAT_TIMEOUT_MS in
  // browser-session-manager.ts).
  useEffect(() => {
    if (!sessionId) return;
    browserSessionClient.heartbeat(sessionId);
    const id = setInterval(() => browserSessionClient.heartbeat(sessionId), 30_000);
    return () => clearInterval(id);
  }, [sessionId]);

  // Clear any previous load error when URL changes (CDP surfaces its own errors
  // via sessionStatus / sessionError).
  useEffect(() => {
    setLoadError(null);
  }, [loadedUrl, setLoadError]);

  // Translate canvas-relative CSS coords → CDP viewport coords (1920×1080).
  // We measure against the CANVAS (not the overlay) because the canvas is the
  // visible content the user is aiming at — using the overlay's rect can drift
  // by a few pixels if its size doesn't exactly match the canvas (subpixel
  // rounding, double aspect-ratio constraints, letterboxing, etc.).
  const toViewportCoords = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = canvasRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    const scaleX = BROWSER_SESSION_VIEWPORT_WIDTH / rect.width;
    const scaleY = BROWSER_SESSION_VIEWPORT_HEIGHT / rect.height;
    return {
      x: Math.round((e.clientX - rect.left) * scaleX),
      y: Math.round((e.clientY - rect.top) * scaleY),
    };
  };

  // CDP modifiers bitmask: 1=Alt, 2=Ctrl, 4=Meta, 8=Shift
  const buildModifiers = (e: React.KeyboardEvent<HTMLDivElement>): number =>
    (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

  // Inspect mode overrides Browse pointer routing — while inspect is on, the
  // overlay's mousemove drives the hover tooltip and mouse/keys are NOT
  // forwarded to CDP (you can't simultaneously interact AND inspect, same as
  // dev tools).
  const overlayPointer = overlaysVisible ? 'auto' : 'none';

  // Forward browse-mode mouse/wheel to the runner. No-op for non-browse tools.
  //
  // `preventDefault()` on every mouse event matters MORE than just stopping
  // text selection — it also prevents the browser from moving focus to a
  // selected text node (which strips focus from the overlay div, so
  // subsequent typing goes to that node instead of being forwarded to CDP).
  const canForwardInput = tool === 'browse' && !inspectActive && !!sessionId;

  const onBrowseMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!canForwardInput) return;
    e.preventDefault();
    const { x, y } = toViewportCoords(e);
    browserSessionClient.input(sessionId!, {
      kind: 'mouseDown',
      x,
      y,
      button: e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left',
      clickCount: e.detail || 1,
    });
  };
  const onBrowseMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!canForwardInput) return;
    e.preventDefault();
    const { x, y } = toViewportCoords(e);
    browserSessionClient.input(sessionId!, {
      kind: 'mouseUp',
      x,
      y,
      button: e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left',
      clickCount: e.detail || 1,
    });
  };
  const onBrowseMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!canForwardInput) return;
    const { x, y } = toViewportCoords(e);
    browserSessionClient.input(sessionId!, { kind: 'mouseMove', x, y });
  };
  const onBrowseWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!canForwardInput) return;
    e.preventDefault();
    const { x, y } = toViewportCoords(e as unknown as React.MouseEvent<HTMLDivElement>);
    browserSessionClient.input(sessionId!, {
      kind: 'wheel',
      x,
      y,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
    });
  };
  const onBrowseContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    if (canForwardInput) e.preventDefault();
  };

  // Keyboard: forward to runner ONLY when Browse tool is active and the
  // overlay is focused. The overlay is `tabIndex=0`; mouseDown focuses it
  // automatically so typing-after-clicking works as users expect.
  const onBrowseKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!canForwardInput) return;
    e.preventDefault(); // don't let the browser handle (e.g. Tab navigation in funny)
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
    browserSessionClient.input(sessionId!, {
      kind: 'keyDown',
      key: e.key,
      code: e.code,
      text: printable ? e.key : undefined,
      modifiers: buildModifiers(e),
    });
  };

  const onBrowseKeyUp = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!canForwardInput) return;
    e.preventDefault();
    browserSessionClient.input(sessionId!, {
      kind: 'keyUp',
      key: e.key,
      code: e.code,
      modifiers: buildModifiers(e),
    });
  };

  // mouseDown also focuses the overlay so the keyboard listeners attach.
  const onBrowseMouseDownWithFocus = (e: React.MouseEvent<HTMLDivElement>) => {
    if (canForwardInput) {
      (e.currentTarget as HTMLDivElement).focus();
    }
    onBrowseMouseDown(e);
  };

  const showCdpSpinner = sessionStatus === 'spawning';
  const showCdpDisconnected = sessionStatus === 'disconnected';

  // Layout: a 16:9 aspect-ratio wrapper centered in the panel, letterboxed by
  // `bg-background`. Canvas + overlay both fill that wrapper exactly, so
  // click coords map cleanly 1:1 to the visible content.
  return (
    <div className="bg-background relative flex h-full w-full items-center justify-center p-2">
      {sessionId ? (
        <div
          className="relative max-h-full max-w-full"
          style={{
            aspectRatio: BROWSER_SESSION_ASPECT_RATIO,
            width: '100%',
            maxWidth: `calc((100% - 1rem) * 1)`,
          }}
        >
          <div className="absolute inset-0">
            <BrowserSessionCanvas canvasRef={canvasRef} />
          </div>

          <div
            ref={overlayRef}
            data-testid="browser-panel-overlay"
            tabIndex={0}
            className="absolute inset-0 select-none focus:outline-hidden"
            style={{
              pointerEvents: overlayPointer,
              visibility: overlaysVisible ? 'visible' : 'hidden',
              WebkitUserSelect: 'none',
              userSelect: 'none',
            }}
            onMouseDown={onBrowseMouseDownWithFocus}
            onMouseUp={onBrowseMouseUp}
            onMouseMove={onBrowseMouseMove}
            onWheel={onBrowseWheel}
            onKeyDown={onBrowseKeyDown}
            onKeyUp={onBrowseKeyUp}
            onContextMenu={onBrowseContextMenu}
            onDragStart={(e) => e.preventDefault()}
          >
            <PinTool overlayRef={overlayRef} canvasRef={canvasRef} isActive={tool === 'pin'} />
            <RegionTool overlayRef={overlayRef} isActive={tool === 'region'} />
            <DrawTool overlayRef={overlayRef} isActive={tool === 'draw'} />
            <TestIdOverlay />
            <InspectOverlay overlayRef={overlayRef} canvasRef={canvasRef} />
          </div>
        </div>
      ) : (
        <div
          className="text-muted-foreground text-center text-sm"
          data-testid="browser-panel-empty"
        >
          {loadedUrl ? null : 'Paste a URL above to start.'}
        </div>
      )}

      {showCdpSpinner && (
        <div
          data-testid="browser-panel-spawning"
          className="bg-background/80 text-muted-foreground absolute inset-0 flex items-center justify-center text-sm"
        >
          Spawning Chrome…
        </div>
      )}

      {showCdpDisconnected && (
        <div
          data-testid="browser-panel-disconnected"
          className="bg-background/90 text-muted-foreground absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-sm"
        >
          <div>Browser session disconnected.</div>
          {useBrowserPanelStore.getState().sessionError && (
            <pre
              data-testid="browser-panel-session-error"
              className="border-destructive/30 bg-destructive/5 text-destructive max-h-40 max-w-full overflow-auto rounded-md border p-2 text-left text-xs whitespace-pre-wrap"
            >
              {useBrowserPanelStore.getState().sessionError}
            </pre>
          )}
          <button
            type="button"
            data-testid="browser-panel-reconnect"
            onClick={() => {
              if (loadedUrl) void useBrowserPanelStore.getState().openBrowserSession(loadedUrl);
            }}
            className="border-border bg-card text-foreground hover:bg-muted rounded-md border px-3 py-1"
          >
            Reconnect
          </button>
        </div>
      )}
    </div>
  );
}
