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

const pinLog = createClientLogger('browser-session');

interface PinToolProps {
  overlayRef: RefObject<HTMLDivElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  isActive: boolean;
}

/**
 * Pin tool. Always renders existing pin markers (so they remain visible when
 * the user switches tools). Click-to-add behavior is gated by `isActive`.
 */
export function PinTool({ overlayRef, canvasRef, isActive }: PinToolProps) {
  const annotations = useBrowserPanelStore((s) => s.annotations);
  const addAnnotation = useBrowserPanelStore((s) => s.addAnnotation);
  const updateAnnotationNote = useBrowserPanelStore((s) => s.updateAnnotationNote);
  const updateAnnotationDom = useBrowserPanelStore((s) => s.updateAnnotationDom);
  const sessionId = useBrowserPanelStore((s) => s.sessionId);

  const [openPinId, setOpenPinId] = useState<string | null>(null);

  const pins = annotations
    .map((a, i) => ({ a, index: i + 1 }))
    .filter(({ a }) => a.kind === 'pin') as Array<{
    a: Extract<(typeof annotations)[number], { kind: 'pin' }>;
    index: number;
  }>;

  const handleAddPin = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isActive) return;
    if ((e.target as HTMLElement).dataset.pinMarker === 'true') return;
    const overlayRect = overlayRef.current?.getBoundingClientRect();
    const canvasRect = canvasRef.current?.getBoundingClientRect();
    if (!overlayRect || !canvasRect || canvasRect.width === 0 || canvasRect.height === 0) return;
    const x = Math.round(e.clientX - overlayRect.left);
    const y = Math.round(e.clientY - overlayRect.top);

    const id = addAnnotation({ kind: 'pin', x, y, note: '' });
    setOpenPinId(id);

    // Resolve the underlying DOM element via CDP `inspect-at` and attach it
    // to the annotation when it returns. The pin marker renders immediately
    // at the click coords; the DOM info fills in asynchronously.
    if (!sessionId) return;
    // Use the CANVAS rect (not the overlay) for CDP scaling — see toViewportCoords in BrowserViewport.
    const viewportX = Math.round(((e.clientX - canvasRect.left) / canvasRect.width) * VIEWPORT_W);
    const viewportY = Math.round(((e.clientY - canvasRect.top) / canvasRect.height) * VIEWPORT_H);
    browserSessionClient
      .inspectAt(sessionId, viewportX, viewportY)
      .then((dom) => {
        if (dom && typeof dom === 'object') {
          updateAnnotationDom(id, dom as AnnotationDomInfo);
        }
      })
      .catch((err) => {
        pinLog.debug('inspectAt failed', { error: String(err) });
      });
  };

  return (
    <>
      {/* Catch-all click surface for adding new pins. Only intercepts events
          when this tool is active; otherwise it's invisible & inert. */}
      {isActive && (
        <div
          data-testid="pin-tool-surface"
          className="absolute inset-0 cursor-crosshair"
          onClick={handleAddPin}
        />
      )}

      {pins.map(({ a, index }) => (
        <Popover
          key={a.id}
          open={openPinId === a.id}
          onOpenChange={(open) => setOpenPinId(open ? a.id : null)}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              data-pin-marker="true"
              data-testid={`browser-panel-pin-${index}`}
              className="border-background bg-primary text-primary-foreground absolute flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 text-xs font-semibold shadow-md transition-transform hover:scale-110"
              style={{ left: a.x, top: a.y, pointerEvents: 'auto' }}
              onClick={(e) => {
                e.stopPropagation();
                setOpenPinId(a.id);
              }}
            >
              {index}
            </button>
          </PopoverTrigger>
          <PopoverContent side="right" align="start" className="w-64">
            <PinNoteEditor
              initial={a.note}
              onSave={(note) => {
                updateAnnotationNote(a.id, note);
                setOpenPinId(null);
              }}
              onCancel={() => setOpenPinId(null)}
            />
          </PopoverContent>
        </Popover>
      ))}
    </>
  );
}

function PinNoteEditor({
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
        placeholder="What's wrong here?"
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
        <Button size="sm" onClick={() => onSave(value)} data-testid="browser-panel-pin-save">
          Save
        </Button>
      </div>
    </div>
  );
}
