import { useEffect, useRef, useState, type RefObject } from 'react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { DRAW_COLORS, useBrowserPanelStore, type Annotation } from '@/stores/browser-panel-store';
import {
  PROSE_FONT_SIZE_PX,
  PROSE_LINE_HEIGHT_PX,
  useSettingsStore,
} from '@/stores/settings-store';

interface DrawToolProps {
  overlayRef: RefObject<HTMLDivElement | null>;
  isActive: boolean;
}

const STROKE_WIDTH = 3;

/**
 * Draw tool. Renders a canvas sized to the overlay (with devicePixelRatio
 * scaling), plus a color palette / Clear button / shared note textarea.
 *
 * Lazy serialization: stroke data lives only in the canvas bitmap until send
 * time, when `SendDialog` reads `drawCanvasRef` from the store and calls
 * `toDataURL('image/png')`.
 */
export function DrawTool({ overlayRef, isActive }: DrawToolProps) {
  const drawColor = useBrowserPanelStore((s) => s.drawColor);
  const setDrawColor = useBrowserPanelStore((s) => s.setDrawColor);
  const setDrawCanvasRef = useBrowserPanelStore((s) => s.setDrawCanvasRef);
  const addAnnotation = useBrowserPanelStore((s) => s.addAnnotation);
  const updateAnnotationNote = useBrowserPanelStore((s) => s.updateAnnotationNote);
  const clearDraw = useBrowserPanelStore((s) => s.clearDraw);
  const annotations = useBrowserPanelStore((s) => s.annotations);
  const fontSize = useSettingsStore((s) => s.fontSize);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);

  const drawAnnotation = annotations.find(
    (a): a is Extract<Annotation, { kind: 'draw' }> => a.kind === 'draw',
  );

  // Size the canvas to match the overlay, with devicePixelRatio scaling for
  // crispness. Re-run whenever the overlay resizes (panel width change, etc.).
  useEffect(() => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;

    setDrawCanvasRef(canvas);

    const resize = () => {
      const rect = overlay.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      // Preserve existing strokes across a resize by snapshotting first.
      const snapshot =
        canvas.width > 0 && canvas.height > 0
          ? ctx.getImageData(0, 0, canvas.width, canvas.height)
          : null;
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = STROKE_WIDTH;
      if (snapshot) ctx.putImageData(snapshot, 0, 0);
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(overlay);

    return () => {
      ro.disconnect();
      setDrawCanvasRef(null);
    };
  }, [overlayRef, setDrawCanvasRef]);

  const ensureDrawAnnotation = () => {
    const has = useBrowserPanelStore.getState().annotations.some((a) => a.kind === 'draw');
    if (!has) {
      addAnnotation({ kind: 'draw', dataUrl: '', color: drawColor, note: '' });
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isActive) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ensureDrawAnnotation();
    canvas.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    const rect = canvas.getBoundingClientRect();
    ctx.strokeStyle = drawColor;
    ctx.lineWidth = STROKE_WIDTH;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(e.clientX - rect.left, e.clientY - rect.top);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    ctx.lineTo(e.clientX - rect.left, e.clientY - rect.top);
    ctx.stroke();
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const canvas = canvasRef.current;
    if (canvas) canvas.releasePointerCapture(e.pointerId);
    drawingRef.current = false;
  };

  return (
    <>
      <canvas
        ref={canvasRef}
        data-testid="browser-panel-draw-canvas"
        className={cn('absolute inset-0 h-full w-full', isActive && 'cursor-crosshair')}
        style={{ pointerEvents: isActive ? 'auto' : 'none' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />

      {isActive && (
        <DrawToolbar
          drawColor={drawColor}
          setDrawColor={setDrawColor}
          onClear={clearDraw}
          drawAnnotation={drawAnnotation ?? null}
          updateAnnotationNote={updateAnnotationNote}
          fontStyle={{
            fontSize: PROSE_FONT_SIZE_PX[fontSize],
            lineHeight: `${PROSE_LINE_HEIGHT_PX[fontSize]}px`,
          }}
        />
      )}
    </>
  );
}

function DrawToolbar({
  drawColor,
  setDrawColor,
  onClear,
  drawAnnotation,
  updateAnnotationNote,
  fontStyle,
}: {
  drawColor: string;
  setDrawColor: (c: string) => void;
  onClear: () => void;
  drawAnnotation: Extract<Annotation, { kind: 'draw' }> | null;
  updateAnnotationNote: (id: string, note: string) => void;
  fontStyle: React.CSSProperties;
}) {
  const [localNote, setLocalNote] = useState(drawAnnotation?.note ?? '');

  useEffect(() => {
    setLocalNote(drawAnnotation?.note ?? '');
  }, [drawAnnotation?.id, drawAnnotation?.note]);

  return (
    <div
      data-testid="browser-panel-draw-toolbar"
      className="border-border bg-card/95 absolute bottom-2 left-1/2 z-10 flex max-w-[90%] -translate-x-1/2 flex-col gap-2 rounded-md border p-2 shadow-md backdrop-blur-sm"
    >
      <div className="flex items-center gap-2">
        {DRAW_COLORS.map((color) => {
          const active = color === drawColor;
          return (
            <button
              key={color}
              type="button"
              data-testid={`browser-panel-draw-swatch-${color.slice(1)}`}
              aria-label={`Color ${color}`}
              aria-pressed={active}
              onClick={() => setDrawColor(color)}
              className={cn(
                'size-6 rounded-full border-2 transition-transform',
                active ? 'scale-110 border-foreground' : 'border-border hover:scale-105',
              )}
              style={{ backgroundColor: color }}
            />
          );
        })}
        <Button
          variant="outline"
          size="sm"
          data-testid="browser-panel-draw-clear"
          onClick={onClear}
        >
          Clear
        </Button>
      </div>
      <Textarea
        rows={2}
        placeholder={
          drawAnnotation ? 'Add a note about what you drew' : 'Start drawing — then add a note'
        }
        disabled={!drawAnnotation}
        value={localNote}
        onChange={(e) => setLocalNote(e.target.value)}
        onBlur={() => {
          if (drawAnnotation) updateAnnotationNote(drawAnnotation.id, localNote);
        }}
        style={fontStyle}
        data-testid="browser-panel-draw-note"
      />
    </div>
  );
}
