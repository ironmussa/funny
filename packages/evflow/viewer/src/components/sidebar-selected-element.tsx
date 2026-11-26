import { Code } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';

import type { ElementDef, SourceRef } from '../../../src/types';

interface SelectedElementDetailsProps {
  name: string;
  el: ElementDef;
  onClear: () => void;
  onOpenSource: (source: SourceRef) => void;
}

/** Details of the element selected in the graph, shown at the bottom of the sidebar. */
export function SelectedElementDetails({
  name,
  el,
  onClear,
  onOpenSource,
}: SelectedElementDetailsProps) {
  return (
    <ScrollArea edgeFade className="flex-1">
      <div className="p-2">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-muted-foreground text-[10px] tracking-wider uppercase">
            Selected
          </span>
          <Button
            variant="ghost"
            size="xs"
            onClick={onClear}
            className="h-5 px-1 text-[10px]"
            data-testid="viewer-selection-clear"
          >
            clear
          </Button>
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">{name}</p>
          <Badge variant="outline" className="text-[10px]">
            {el.kind}
          </Badge>
          {el.description && <p className="text-muted-foreground text-xs">{el.description}</p>}
          {'fields' in el && el.fields && (
            <div>
              <span className="text-muted-foreground mb-1 block text-[10px] uppercase">Fields</span>
              {Object.entries(el.fields).map(([k, v]) => (
                <p key={k} className="text-muted-foreground text-xs">
                  <span className="text-foreground">{k}</span>: {v}
                </p>
              ))}
            </div>
          )}
          {'invariants' in el && el.invariants?.length > 0 && (
            <div>
              <span className="text-muted-foreground mb-1 block text-[10px] uppercase">
                Invariants
              </span>
              {el.invariants.map((inv, i) => (
                <p key={i} className="text-muted-foreground text-xs">
                  - {inv}
                </p>
              ))}
            </div>
          )}
          {'handles' in el && (
            <div>
              <span className="text-muted-foreground mb-1 block text-[10px] uppercase">
                Handles
              </span>
              {el.handles.map((h, i) => (
                <p key={i} className="text-muted-foreground text-xs">
                  {h}
                </p>
              ))}
            </div>
          )}
          {'emits' in el && el.emits?.length > 0 && (
            <div>
              <span className="text-muted-foreground mb-1 block text-[10px] uppercase">Emits</span>
              {el.emits.map((e, i) => (
                <p key={i} className="text-muted-foreground text-xs">
                  {e}
                </p>
              ))}
            </div>
          )}
          {'from' in el && (
            <div>
              <span className="text-muted-foreground mb-1 block text-[10px] uppercase">
                Projects from
              </span>
              {el.from.map((f, i) => (
                <p key={i} className="text-muted-foreground text-xs">
                  {f}
                </p>
              ))}
            </div>
          )}
          {'displays' in el && (
            <div>
              <span className="text-muted-foreground mb-1 block text-[10px] uppercase">
                Displays
              </span>
              {el.displays.map((d, i) => (
                <p key={i} className="text-muted-foreground text-xs">
                  {d}
                </p>
              ))}
            </div>
          )}
          {'triggers' in el && (
            <div>
              <span className="text-muted-foreground mb-1 block text-[10px] uppercase">
                Triggers
              </span>
              {(Array.isArray(el.triggers) ? el.triggers : [el.triggers]).map(
                (t: string, i: number) => (
                  <p key={i} className="text-muted-foreground text-xs">
                    {t}
                  </p>
                ),
              )}
            </div>
          )}
          {'on' in el && (
            <div>
              <span className="text-muted-foreground mb-1 block text-[10px] uppercase">
                Listens to
              </span>
              {(Array.isArray(el.on) ? el.on : [el.on]).map((o: string, i: number) => (
                <p key={i} className="text-muted-foreground text-xs">
                  {o}
                </p>
              ))}
            </div>
          )}
          {el.source && (
            <div>
              <Separator className="my-2" />
              <Button
                variant="outline"
                size="xs"
                onClick={() => onOpenSource(el.source!)}
                className="w-full gap-1.5"
                data-testid="viewer-source-open"
              >
                <Code className="h-3 w-3" />
                <span className="truncate text-[10px]">{el.source.file}</span>
              </Button>
            </div>
          )}
        </div>
      </div>
    </ScrollArea>
  );
}
