import { MapPin, Pencil, Square, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useBrowserPanelStore, type Annotation } from '@/stores/browser-panel-store';
import {
  PROSE_FONT_SIZE_PX,
  PROSE_LINE_HEIGHT_PX,
  useSettingsStore,
} from '@/stores/settings-store';

const NOTE_SNIPPET_MAX = 60;

function summarize(a: Annotation): string {
  switch (a.kind) {
    case 'pin':
      return `(${a.x}, ${a.y})`;
    case 'region':
      return `(${a.x}, ${a.y}, ${a.w}×${a.h})`;
    case 'draw':
      return 'drawing';
  }
}

function kindIcon(kind: Annotation['kind']) {
  switch (kind) {
    case 'pin':
      return MapPin;
    case 'region':
      return Square;
    case 'draw':
      return Pencil;
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function AnnotationList() {
  const annotations = useBrowserPanelStore((s) => s.annotations);
  const removeAnnotation = useBrowserPanelStore((s) => s.removeAnnotation);
  const fontSize = useSettingsStore((s) => s.fontSize);

  const fontStyle = {
    fontSize: PROSE_FONT_SIZE_PX[fontSize],
    lineHeight: `${PROSE_LINE_HEIGHT_PX[fontSize]}px`,
  };

  if (annotations.length === 0) {
    return (
      <div
        className="text-muted-foreground flex h-full items-center justify-center px-3 py-2"
        style={fontStyle}
        data-testid="browser-panel-annotation-list-empty"
      >
        No annotations yet. Pick a tool and start marking up the page.
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <ul
        data-testid="browser-panel-annotation-list"
        className="divide-border flex flex-col divide-y"
        style={fontStyle}
      >
        {annotations.map((a, i) => {
          const Icon = kindIcon(a.kind);
          const snippet = truncate(a.note.trim(), NOTE_SNIPPET_MAX);
          return (
            <li
              key={a.id}
              className="flex items-start gap-2 px-3 py-2"
              data-testid={`browser-panel-annotation-${i + 1}`}
            >
              <span
                aria-hidden="true"
                className="bg-muted text-foreground mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
              >
                {i + 1}
              </span>
              <Icon className="text-muted-foreground mt-1 size-3.5 shrink-0" aria-label={a.kind} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-muted-foreground">{summarize(a)}</span>
                {snippet && <span className="truncate">{snippet}</span>}
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                tabIndex={-1}
                data-testid={`browser-panel-annotation-remove-${a.id}`}
                aria-label={`Remove annotation ${i + 1}`}
                onClick={() => removeAnnotation(a.id)}
                className="text-muted-foreground hover:text-destructive shrink-0"
              >
                <Trash2 className="icon-base" />
              </Button>
            </li>
          );
        })}
      </ul>
    </ScrollArea>
  );
}
