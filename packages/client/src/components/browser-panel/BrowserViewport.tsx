import { useEffect, useRef } from 'react';

import { EmptyState } from '@/components/ui/empty-state';
import { LoadingState } from '@/components/ui/loading-state';
import { browserSessionClient } from '@/lib/browser-session-client';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';

import { BrowserSessionCanvas } from './BrowserSessionCanvas';
import { InspectOverlay } from './InspectOverlay';
import { TestIdOverlay } from './TestIdOverlay';
import { DrawTool } from './tools/DrawTool';
import { PinTool } from './tools/PinTool';
import { RegionTool } from './tools/RegionTool';

// CDP modifiers bitmask: 1=Alt, 2=Ctrl, 4=Meta, 8=Shift
const buildModifiers = (event: React.KeyboardEvent | React.MouseEvent): number =>
  (event.altKey ? 1 : 0) |
  (event.ctrlKey ? 2 : 0) |
  (event.metaKey ? 4 : 0) |
  (event.shiftKey ? 8 : 0);

export function BrowserViewport() {
  const sessionId = useBrowserPanelStore((s) => s.sessionId);
  const loadedUrl = useBrowserPanelStore((s) => s.loadedUrl);
  const setLoadError = useBrowserPanelStore((s) => s.setLoadError);
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

  return (
    <div className="bg-background relative flex h-full w-full items-center justify-center p-2">
      {sessionId ? (
        <ActiveBrowserViewport />
      ) : (
        <EmptyState
          fill={false}
          testId="browser-panel-empty"
          title={loadedUrl ? null : 'Paste a URL above to start.'}
        />
      )}
      <BrowserSessionStatus />
    </div>
  );
}

function ActiveBrowserViewport() {
  const userControls = useBrowserPanelStore((s) => !s.sessionThreadId || s.controller === 'user');
  const annotationMode = useBrowserPanelStore((s) => s.annotationMode);
  const annotating = userControls && annotationMode;
  const tool = useBrowserPanelStore((s) => s.tool);
  const overlaysVisible = useBrowserPanelStore((s) => s.overlaysVisible);
  const sessionId = useBrowserPanelStore((s) => s.sessionId);
  const viewport = useBrowserPanelStore((s) => s.viewport);
  const inspectActive = useBrowserPanelStore((s) => s.inspectActive);

  const overlayRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const showAnnotations = annotating && overlaysVisible;
  const canForwardInput = acceptsBrowserInput(
    userControls,
    annotating,
    tool,
    inspectActive,
    sessionId,
  );
  const inputHandlers = useBrowserInputHandlers(canvasRef, viewport, sessionId, canForwardInput);

  return (
    <div
      className="relative max-h-full max-w-full"
      style={{
        aspectRatio: `${viewport.width} / ${viewport.height}`,
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
        role="application"
        aria-label="Remote browser viewport"
        // Capture-phase shortcuts (Ctrl+F) skip targets inside this.
        data-keyboard-passthrough
        tabIndex={userControls ? 0 : -1}
        className="absolute inset-0 select-none focus:outline-hidden"
        style={{
          pointerEvents: userControls ? 'auto' : 'none',
          WebkitUserSelect: 'none',
          userSelect: 'none',
        }}
        onMouseDown={inputHandlers.onBrowseMouseDownWithFocus}
        onMouseUp={inputHandlers.onBrowseMouseUp}
        onMouseMove={inputHandlers.onBrowseMouseMove}
        onWheel={inputHandlers.onBrowseWheel}
        onKeyDown={inputHandlers.onBrowseKeyDown}
        onKeyUp={inputHandlers.onBrowseKeyUp}
        onContextMenu={inputHandlers.onBrowseContextMenu}
        onDragStart={(e) => e.preventDefault()}
      >
        <BrowserAnnotations
          overlayRef={overlayRef}
          canvasRef={canvasRef}
          showAnnotations={showAnnotations}
          tool={tool}
        />
      </div>
    </div>
  );
}

function DisconnectedBrowser() {
  const sessionError = useBrowserPanelStore((s) => s.sessionError);
  const loadedUrl = useBrowserPanelStore((s) => s.loadedUrl);
  const openBrowserSession = useBrowserPanelStore((s) => s.openBrowserSession);
  return (
    <div
      data-testid="browser-panel-disconnected"
      className="bg-background/90 text-muted-foreground absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-sm"
    >
      <div>Browser session disconnected.</div>
      {sessionError && (
        <pre
          data-testid="browser-panel-session-error"
          className="border-destructive/30 bg-destructive/5 text-destructive max-h-40 max-w-full overflow-auto rounded-md border p-2 text-left text-xs whitespace-pre-wrap"
        >
          {sessionError}
        </pre>
      )}
      <button
        type="button"
        data-testid="browser-panel-reconnect"
        onClick={() => {
          if (loadedUrl) void openBrowserSession(loadedUrl);
        }}
        className="border-border bg-card text-foreground hover:bg-muted rounded-md border px-3 py-1"
      >
        Reconnect
      </button>
    </div>
  );
}

function BrowserAnnotations({
  overlayRef,
  canvasRef,
  showAnnotations,
  tool,
}: {
  overlayRef: React.RefObject<HTMLDivElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  showAnnotations: boolean;
  tool: string;
}) {
  return (
    <div
      className="absolute inset-0"
      style={{
        visibility: showAnnotations ? 'visible' : 'hidden',
        pointerEvents: showAnnotations ? 'auto' : 'none',
      }}
      aria-hidden={!showAnnotations}
    >
      <PinTool
        overlayRef={overlayRef}
        canvasRef={canvasRef}
        isActive={showAnnotations && tool === 'pin'}
      />
      <RegionTool overlayRef={overlayRef} isActive={showAnnotations && tool === 'region'} />
      <DrawTool overlayRef={overlayRef} isActive={showAnnotations && tool === 'draw'} />
      {showAnnotations && <TestIdOverlay />}
      {showAnnotations && <InspectOverlay overlayRef={overlayRef} canvasRef={canvasRef} />}
    </div>
  );
}

function useBrowserInputHandlers(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  viewport: { width: number; height: number },
  sessionId: string | null,
  canForwardInput: boolean,
) {
  // Translate canvas-relative CSS coords → CDP viewport coords (the session's
  // page viewport — 1920×1080 unless the agent resized it).
  // We measure against the CANVAS (not the overlay) because the canvas is the
  // visible content the user is aiming at — using the overlay's rect can drift
  // by a few pixels if its size doesn't exactly match the canvas (subpixel
  // rounding, double aspect-ratio constraints, letterboxing, etc.).
  const toViewportCoords = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = canvasRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    const scaleX = viewport.width / rect.width;
    const scaleY = viewport.height / rect.height;
    return {
      x: Math.round((e.clientX - rect.left) * scaleX),
      y: Math.round((e.clientY - rect.top) * scaleY),
    };
  };

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
      modifiers: buildModifiers(e),
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
      modifiers: buildModifiers(e),
    });
  };
  const onBrowseMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!canForwardInput) return;
    const { x, y } = toViewportCoords(e);
    browserSessionClient.input(sessionId!, {
      kind: 'mouseMove',
      x,
      y,
      buttons: e.buttons,
      modifiers: buildModifiers(e),
    });
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
    // Keys typed into the remote page are the page's: funny's own shortcuts
    // (`?`, Ctrl+P, Alt+←…) listen on `window` and must not see them.
    e.stopPropagation();
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
    browserSessionClient.input(sessionId!, {
      kind: 'keyDown',
      key: e.key,
      code: e.code,
      text: printable ? e.key : undefined,
      modifiers: buildModifiers(e),
      keyCode: e.keyCode,
      location: e.location,
    });
  };

  const onBrowseKeyUp = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!canForwardInput) return;
    e.preventDefault();
    e.stopPropagation();
    browserSessionClient.input(sessionId!, {
      kind: 'keyUp',
      key: e.key,
      code: e.code,
      modifiers: buildModifiers(e),
      keyCode: e.keyCode,
      location: e.location,
    });
  };

  // mouseDown also focuses the overlay so the keyboard listeners attach.
  const onBrowseMouseDownWithFocus = (e: React.MouseEvent<HTMLDivElement>) => {
    if (canForwardInput) {
      (e.currentTarget as HTMLDivElement).focus();
    }
    onBrowseMouseDown(e);
  };

  return {
    onBrowseMouseDownWithFocus,
    onBrowseMouseUp,
    onBrowseMouseMove,
    onBrowseWheel,
    onBrowseKeyDown,
    onBrowseKeyUp,
    onBrowseContextMenu,
  };
}

function acceptsBrowserInput(
  userControls: boolean,
  annotating: boolean,
  tool: string,
  inspectActive: boolean,
  sessionId: string | null,
) {
  return userControls && (!annotating || (tool === 'browse' && !inspectActive)) && !!sessionId;
}

function BrowserSessionStatus() {
  const sessionStatus = useBrowserPanelStore((s) => s.sessionStatus);
  const showCdpSpinner = sessionStatus === 'spawning';
  const showCdpDisconnected = sessionStatus === 'disconnected';
  return (
    <>
      {showCdpSpinner && (
        <LoadingState
          testId="browser-panel-spawning"
          className="bg-background/80 absolute inset-0"
          label="Spawning Chrome…"
        />
      )}

      {showCdpDisconnected && <DisconnectedBrowser />}
    </>
  );
}
