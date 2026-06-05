import { useState, type RefObject } from 'react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { browserSessionClient } from '@/lib/browser-session-client';
import {
  BROWSER_SESSION_VIEWPORT_HEIGHT as VIEWPORT_H,
  BROWSER_SESSION_VIEWPORT_WIDTH as VIEWPORT_W,
} from '@/lib/browser-session-viewport';
import { createClientLogger } from '@/lib/client-logger';
import { useBrowserPanelStore, type AnnotationDomInfo } from '@/stores/browser-panel-store';
import {
  PROSE_FONT_SIZE_PX,
  PROSE_LINE_HEIGHT_PX,
  useSettingsStore,
} from '@/stores/settings-store';

const regionLog = createClientLogger('browser-session');

interface RegionToolProps {
  overlayRef: RefObject<HTMLDivElement | null>;
  isActive: boolean;
}

interface DragState {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

const MIN_REGION_PX = 5;

/**
 * Region tool. Drag on the overlay to draw a rectangle; on commit the region
 * is appended to the annotations and a popover for its note opens.
 */
export function RegionTool({ overlayRef, isActive }: RegionToolProps) {
  const annotations = useBrowserPanelStore((s) => s.annotations);
  const addAnnotation = useBrowserPanelStore((s) => s.addAnnotation);
  const updateAnnotationNote = useBrowserPanelStore((s) => s.updateAnnotationNote);
  const updateRegionDom = useBrowserPanelStore((s) => s.updateRegionDom);
  const sessionId = useBrowserPanelStore((s) => s.sessionId);

  const [drag, setDrag] = useState<DragState | null>(null);
  const [openRegionId, setOpenRegionId] = useState<string | null>(null);

  const regions = annotations
    .map((a, i) => ({ a, index: i + 1 }))
    .filter(({ a }) => a.kind === 'region') as Array<{
    a: Extract<(typeof annotations)[number], { kind: 'region' }>;
    index: number;
  }>;

  const getCoords = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return {
      x: Math.round(e.clientX - rect.left),
      y: Math.round(e.clientY - rect.top),
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isActive) return;
    if ((e.target as HTMLElement).dataset.regionMarker === 'true') return;
    const coords = getCoords(e);
    if (!coords) return;
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    setDrag({ startX: coords.x, startY: coords.y, currentX: coords.x, currentY: coords.y });
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const coords = getCoords(e);
    if (!coords) return;
    setDrag({ ...drag, currentX: coords.x, currentY: coords.y });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    const x = Math.min(drag.startX, drag.currentX);
    const y = Math.min(drag.startY, drag.currentY);
    const w = Math.abs(drag.startX - drag.currentX);
    const h = Math.abs(drag.startY - drag.currentY);
    setDrag(null);
    if (w < MIN_REGION_PX || h < MIN_REGION_PX) return;

    const id = addAnnotation({ kind: 'region', x, y, w, h, note: '' });
    setOpenRegionId(id);

    // Resolve which elements fall inside the region via CDP `inspectRect`.
    // The marker renders immediately at the drawn coords; DOM info fills in
    // asynchronously when the runner responds.
    if (!sessionId) return;
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect) return;
    const vx = Math.round((x / rect.width) * VIEWPORT_W);
    const vy = Math.round((y / rect.height) * VIEWPORT_H);
    const vw = Math.round((w / rect.width) * VIEWPORT_W);
    const vh = Math.round((h / rect.height) * VIEWPORT_H);
    browserSessionClient
      .inspectRect(sessionId, vx, vy, vw, vh)
      .then((elements) => {
        if (Array.isArray(elements)) {
          updateRegionDom(id, {
            rect: { x: vx, y: vy, w: vw, h: vh },
            elements: elements as AnnotationDomInfo[],
          });
        }
      })
      .catch((err) => {
        regionLog.debug('inspectRect failed', { error: String(err) });
      });
  };

  const liveRect = drag
    ? {
        x: Math.min(drag.startX, drag.currentX),
        y: Math.min(drag.startY, drag.currentY),
        w: Math.abs(drag.startX - drag.currentX),
        h: Math.abs(drag.startY - drag.currentY),
      }
    : null;

  return (
    <>
      {isActive && (
        <div
          data-testid="region-tool-surface"
          className="absolute inset-0 cursor-crosshair"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={() => setDrag(null)}
        />
      )}

      {liveRect && (
        <div
          aria-hidden="true"
          className="border-primary bg-primary/10 pointer-events-none absolute border-2 border-dashed"
          style={{
            left: liveRect.x,
            top: liveRect.y,
            width: liveRect.w,
            height: liveRect.h,
          }}
        />
      )}

      {regions.map(({ a, index }) => (
        <Popover
          key={a.id}
          open={openRegionId === a.id}
          onOpenChange={(open) => setOpenRegionId(open ? a.id : null)}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              data-region-marker="true"
              data-testid={`browser-panel-region-${index}`}
              className="border-primary bg-primary/5 hover:bg-primary/15 absolute flex items-start justify-end border-2 border-dashed transition-colors"
              style={{
                left: a.x,
                top: a.y,
                width: a.w,
                height: a.h,
                pointerEvents: 'auto',
              }}
              onClick={(e) => {
                e.stopPropagation();
                setOpenRegionId(a.id);
              }}
            >
              <span className="bg-primary text-primary-foreground m-0.5 inline-flex size-5 items-center justify-center rounded-full text-[10px] font-semibold">
                {index}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent side="right" align="start" className="w-64">
            <RegionNoteEditor
              initial={a.note}
              onSave={(note) => {
                updateAnnotationNote(a.id, note);
                setOpenRegionId(null);
              }}
              onCancel={() => setOpenRegionId(null)}
            />
          </PopoverContent>
        </Popover>
      ))}
    </>
  );
}

function RegionNoteEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (note: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const fontStyle: React.CSSProperties = {
    fontSize: PROSE_FONT_SIZE_PX[fontSize],
    lineHeight: `${PROSE_LINE_HEIGHT_PX[fontSize]}px`,
  };
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        autoFocus
        rows={3}
        placeholder="What's wrong in this region?"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        style={fontStyle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSave(value);
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => onSave(value)} data-testid="browser-panel-region-save">
          Save
        </Button>
      </div>
    </div>
  );
}
