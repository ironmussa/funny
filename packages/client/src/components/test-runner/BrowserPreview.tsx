import AnsiToHtml from 'ansi-to-html';
import { Monitor, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { cn } from '@/lib/utils';
import { useTestStore } from '@/stores/test-store';

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

interface OutputLine {
  line: string;
  stream: 'stdout' | 'stderr';
  timestamp: number;
}

interface BrowserPreviewProps {
  isRunning: boolean;
  isStreaming: boolean;
  outputLines: OutputLine[];
}

export function BrowserPreview({ isRunning, isStreaming, outputLines }: BrowserPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const userScrolled = useRef(false);

  const ansiConverter = useMemo(
    () => new AnsiToHtml({ fg: '#a1a1aa', bg: 'transparent', newline: false, escapeXML: true }),
    [],
  );

  // Listen for frame events
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const handleFrame = () => {
      if (!latestFrameData) return;

      const img = new Image();
      img.onload = () => {
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);
        useTestStore.getState().setStreaming(true);
      };
      img.src = `data:image/jpeg;base64,${latestFrameData}`;
    };

    window.addEventListener('test:frame', handleFrame);
    return () => window.removeEventListener('test:frame', handleFrame);
  }, []);

  // Auto-scroll log
  useEffect(() => {
    if (!logRef.current || userScrolled.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [outputLines.length]);

  const handleLogScroll = () => {
    if (!logRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logRef.current;
    userScrolled.current = scrollHeight - scrollTop - clientHeight > 40;
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Browser stream canvas */}
      <div className="relative flex min-h-0 flex-[3] items-center justify-center border-b bg-black/5">
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
        />
      </div>

      {/* Test output log */}
      <div
        ref={logRef}
        onScroll={handleLogScroll}
        className="min-h-0 flex-1 overflow-y-auto bg-zinc-950 p-2 font-mono text-xs"
      >
        {outputLines.length === 0 ? (
          <div className="py-4 text-center text-zinc-500">Test output will appear here...</div>
        ) : (
          outputLines.map((line, i) => (
            <div
              key={i}
              className={cn(
                'whitespace-pre-wrap break-all leading-5',
                line.stream === 'stderr' ? 'text-red-400' : 'text-zinc-300',
              )}
              dangerouslySetInnerHTML={{ __html: ansiConverter.toHtml(line.line) }}
            />
          ))
        )}
      </div>
    </div>
  );
}
