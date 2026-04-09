import type {
  TestActionBoundingBox,
  TestNetworkEntry,
  WSTestConsoleData,
  WSTestErrorData,
} from '@funny/shared';
import {
  Monitor,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Play,
  Square,
  ZoomIn,
  ZoomOut,
  Maximize2,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ActionList } from '@/components/test-runner/ActionList';
import { ActionTimeline } from '@/components/test-runner/ActionTimeline';
import { TestDetailTabs } from '@/components/test-runner/TestDetailTabs';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { cn } from '@/lib/utils';
import { useTestStore } from '@/stores/test-store';

const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

// CDP screencast viewport dimensions (must match chrome-session.ts config)
const CDP_VIEWPORT_WIDTH = 1280;
const CDP_VIEWPORT_HEIGHT = 720;

// Module-level frame ref to avoid re-renders on each frame
let latestFrameData: string | null = null;

/** Subscribe to test:frame events and render on canvas. */
export function useBrowserFrameRenderer(canvasRef: React.RefObject<HTMLCanvasElement | null>) {
  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !latestFrameData) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const img = new Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
    };
    img.src = `data:image/jpeg;base64,${latestFrameData}`;
  }, [canvasRef]);

  return { drawFrame };
}

/** Render a frame onto the canvas (called from WS handler). */
export function renderFrame(data: string) {
  latestFrameData = data;
  // Custom event to notify the component
  window.dispatchEvent(new CustomEvent('test:frame'));
}

/** Draw a highlight rectangle on the canvas for the targeted element. */
function drawHighlightOverlay(canvas: HTMLCanvasElement, bbox: TestActionBoundingBox) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Scale from viewport coords to canvas pixel coords
  const scaleX = canvas.width / CDP_VIEWPORT_WIDTH;
  const scaleY = canvas.height / CDP_VIEWPORT_HEIGHT;

  const x = bbox.x * scaleX;
  const y = bbox.y * scaleY;
  const w = bbox.width * scaleX;
  const h = bbox.height * scaleY;

  // Pink/magenta highlight (matches Playwright UI style)
  ctx.strokeStyle = 'rgba(232, 68, 133, 0.9)';
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);

  ctx.fillStyle = 'rgba(232, 68, 133, 0.12)';
  ctx.fillRect(x, y, w, h);
}

/** Find the frame with timestamp closest to the target. */
function findNearestFrame(
  frames: Array<{ data: string; timestamp: number }>,
  targetTimestamp: number,
): { data: string; timestamp: number } | null {
  if (frames.length === 0) return null;
  let best = frames[0];
  let bestDist = Math.abs(best.timestamp - targetTimestamp);
  for (let i = 1; i < frames.length; i++) {
    const dist = Math.abs(frames[i].timestamp - targetTimestamp);
    if (dist < bestDist) {
      best = frames[i];
      bestDist = dist;
    }
  }
  return best;
}

/** Draw a base64 JPEG frame on the canvas, optionally with a highlight overlay. */
function drawFrameOnCanvas(
  canvas: HTMLCanvasElement,
  frameData: string,
  bbox?: TestActionBoundingBox,
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const img = new Image();
  img.onload = () => {
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);
    if (bbox) drawHighlightOverlay(canvas, bbox);
  };
  img.src = `data:image/jpeg;base64,${frameData}`;
}

interface OutputLine {
  line: string;
  stream: 'stdout' | 'stderr';
  timestamp: number;
}

interface BrowserPreviewProps {
  isRunning: boolean;
  isStreaming: boolean;
  outputLines: OutputLine[];
  consoleEntries: WSTestConsoleData[];
  networkEntries: TestNetworkEntry[];
  errorEntries: WSTestErrorData[];
  activeFile: string | null;
  projectPath: string | undefined;
  onStop?: () => void;
}

export function BrowserPreview({
  isRunning,
  isStreaming,
  outputLines,
  consoleEntries,
  networkEntries,
  errorEntries,
  activeFile,
  projectPath,
  onStop,
}: BrowserPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const browserContainerRef = useRef<HTMLDivElement>(null);

  // Action state from store
  const actions = useTestStore((s) => s.actions);
  const hoveredActionIndex = useTestStore((s) => s.hoveredActionIndex);
  const selectedActionIndex = useTestStore((s) => s.selectedActionIndex);
  const frameHistory = useTestStore((s) => s.frameHistory);
  const setHoveredActionIndex = useTestStore((s) => s.setHoveredActionIndex);
  const setSelectedActionIndex = useTestStore((s) => s.setSelectedActionIndex);

  const hasActions = actions.length > 0;
  const activeIndex = hoveredActionIndex >= 0 ? hoveredActionIndex : selectedActionIndex;
  const isViewingHistorical = activeIndex >= 0;

  const zoomIn = useCallback(() => {
    setZoom((z) => {
      const idx = ZOOM_LEVELS.indexOf(z as any);
      return idx < ZOOM_LEVELS.length - 1 ? ZOOM_LEVELS[idx + 1] : z;
    });
  }, []);

  const zoomOut = useCallback(() => {
    setZoom((z) => {
      const idx = ZOOM_LEVELS.indexOf(z as any);
      return idx > 0 ? ZOOM_LEVELS[idx - 1] : z;
    });
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!browserContainerRef.current) return;
    if (!document.fullscreenElement) {
      browserContainerRef.current.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  }, []);

  // Navigate to previous action
  const prevAction = useCallback(() => {
    const current = selectedActionIndex >= 0 ? selectedActionIndex : actions.length;
    if (current > 0) setSelectedActionIndex(current - 1);
  }, [selectedActionIndex, actions.length, setSelectedActionIndex]);

  // Navigate to next action
  const nextAction = useCallback(() => {
    const current = selectedActionIndex;
    if (current < actions.length - 1) {
      setSelectedActionIndex(current + 1);
    } else {
      // Deselect to go back to live
      setSelectedActionIndex(-1);
    }
  }, [selectedActionIndex, actions.length, setSelectedActionIndex]);

  // Sync fullscreen state on exit via Esc
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  // Listen for live frame events — only render if not viewing historical
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const handleFrame = () => {
      // Skip live frame rendering when viewing a historical action
      const store = useTestStore.getState();
      const idx =
        store.hoveredActionIndex >= 0 ? store.hoveredActionIndex : store.selectedActionIndex;
      if (idx >= 0) return;

      if (!latestFrameData) return;

      const img = new Image();
      img.onload = () => {
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);
        store.setStreaming(true);
      };
      img.src = `data:image/jpeg;base64,${latestFrameData}`;
    };

    window.addEventListener('test:frame', handleFrame);
    return () => window.removeEventListener('test:frame', handleFrame);
  }, []);

  // When hovering/selecting an action, show the historical frame + highlight
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || activeIndex < 0) return;

    const action = actions[activeIndex];
    if (!action) return;

    // Find the nearest frame by timestamp
    const targetTs = action.frameTimestamp ?? action.startTime / 1000;
    const frame = findNearestFrame(frameHistory, targetTs);

    if (frame) {
      drawFrameOnCanvas(canvas, frame.data, action.boundingBox);
    } else if (latestFrameData && action.boundingBox) {
      // No historical frame — draw overlay on current frame
      drawFrameOnCanvas(canvas, latestFrameData, action.boundingBox);
    }
  }, [activeIndex, actions, frameHistory]);

  // When deselecting (going back to live), redraw the latest live frame
  useEffect(() => {
    if (activeIndex >= 0) return; // still viewing historical
    const canvas = canvasRef.current;
    if (!canvas || !latestFrameData) return;
    drawFrameOnCanvas(canvas, latestFrameData);
  }, [activeIndex]);

  return (
    <div ref={browserContainerRef} className="flex h-full flex-col overflow-hidden">
      {/* Browser toolbar */}
      <div className="flex items-center justify-between border-b bg-muted/30 px-2 py-1">
        {/* Left: action navigation */}
        <div className="flex items-center gap-1">
          <TooltipIconButton
            data-testid="browser-prev-action"
            tooltip="Previous action"
            disabled={!hasActions}
            size="icon-xs"
            onClick={prevAction}
          >
            <ChevronLeft className="icon-sm" />
          </TooltipIconButton>
          {isRunning ? (
            <TooltipIconButton
              data-testid="browser-stop"
              tooltip="Stop"
              size="icon-xs"
              onClick={onStop}
              className="text-destructive hover:text-destructive"
            >
              <Square className="icon-sm fill-current" />
            </TooltipIconButton>
          ) : (
            <TooltipIconButton
              data-testid="browser-play"
              tooltip="Play"
              disabled={!isStreaming}
              size="icon-xs"
            >
              <Play className="icon-sm" />
            </TooltipIconButton>
          )}
          <TooltipIconButton
            data-testid="browser-next-action"
            tooltip="Next action"
            disabled={!hasActions}
            size="icon-xs"
            onClick={nextAction}
          >
            <ChevronRight className="icon-sm" />
          </TooltipIconButton>

          {/* Action counter */}
          {hasActions && (
            <span className="ml-1 text-[10px] tabular-nums text-muted-foreground">
              {activeIndex >= 0 ? activeIndex + 1 : '-'} / {actions.length}
            </span>
          )}

          {/* Live indicator */}
          {isViewingHistorical && (
            <button
              className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-muted/80"
              onClick={() => {
                setSelectedActionIndex(-1);
                setHoveredActionIndex(-1);
              }}
              data-testid="browser-go-live"
            >
              Go Live
            </button>
          )}
        </div>

        {/* Right: zoom controls */}
        <div className="flex items-center gap-0.5">
          <TooltipIconButton
            data-testid="browser-zoom-out"
            tooltip="Zoom out"
            size="icon-xs"
            disabled={zoom <= ZOOM_LEVELS[0]}
            onClick={zoomOut}
          >
            <ZoomOut className="icon-sm" />
          </TooltipIconButton>
          <button
            data-testid="browser-zoom-level"
            className="min-w-[32px] rounded px-1 text-center text-xs tabular-nums text-muted-foreground hover:bg-muted"
            onClick={() => setZoom(1)}
            title="Reset zoom"
          >
            {zoom === 1 ? '1x' : `${zoom}x`}
          </button>
          <TooltipIconButton
            data-testid="browser-zoom-in"
            tooltip="Zoom in"
            size="icon-xs"
            disabled={zoom >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1]}
            onClick={zoomIn}
          >
            <ZoomIn className="icon-sm" />
          </TooltipIconButton>
          <TooltipIconButton
            data-testid="browser-fullscreen"
            tooltip={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            size="icon-xs"
            onClick={toggleFullscreen}
          >
            <Maximize2 className="icon-sm" />
          </TooltipIconButton>
        </div>
      </div>

      {/* Timeline */}
      {hasActions && (
        <ActionTimeline
          actions={actions}
          hoveredIndex={hoveredActionIndex}
          selectedIndex={selectedActionIndex}
          onHover={setHoveredActionIndex}
          onSelect={setSelectedActionIndex}
        />
      )}

      {/* Action sidebar + Browser canvas */}
      <div className="flex min-h-0 flex-[2] border-b">
        {/* Action sidebar (appears when actions exist) */}
        {hasActions && (
          <div className="w-[220px] shrink-0 overflow-hidden border-r">
            <ActionList
              actions={actions}
              hoveredIndex={hoveredActionIndex}
              selectedIndex={selectedActionIndex}
              onHover={setHoveredActionIndex}
              onSelect={setSelectedActionIndex}
            />
          </div>
        )}

        {/* Canvas area */}
        <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-auto bg-black/5">
          {!isRunning && !isStreaming ? (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Monitor className="h-8 w-8" />
              <span className="text-sm">No test running</span>
            </div>
          ) : isRunning && !isStreaming ? (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Loader2 className="h-8 w-8 animate-spin" />
              <span className="text-sm">Connecting to browser...</span>
            </div>
          ) : null}
          <canvas
            ref={canvasRef}
            className={cn('max-h-full max-w-full object-contain', !isStreaming && 'hidden')}
            style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
          />
        </div>
      </div>

      {/* Detail tabs (Log, Console, Network, Errors, etc.) */}
      <div className="min-h-0 flex-[2] bg-background">
        <TestDetailTabs
          outputLines={outputLines}
          consoleEntries={consoleEntries}
          networkEntries={networkEntries}
          errorEntries={errorEntries}
          actions={actions}
          activeFile={activeFile}
          projectPath={projectPath}
        />
      </div>
    </div>
  );
}
