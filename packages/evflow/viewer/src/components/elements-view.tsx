import { useMemo } from 'react';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

import { EVFLOW_ICONS } from '../../../src/generators/react-flow';
import type { ElementKind, ElementDef } from '../../../src/types';
import { useViewerStore } from '../stores/viewer-store';

const KIND_LABELS: Record<ElementKind, string> = {
  command: 'Command',
  event: 'Event',
  aggregate: 'Aggregate',
  readModel: 'Read Model',
  screen: 'Screen',
  automation: 'Automation',
  external: 'External',
  saga: 'Saga',
};

export function ElementsView() {
  const model = useViewerStore((s) => s.model);
  const activeKind = useViewerStore((s) => s.activeKind);
  const activeSlice = useViewerStore((s) => s.activeSlice);
  const searchQuery = useViewerStore((s) => s.searchQuery);
  const setSelectedNode = useViewerStore((s) => s.setSelectedNode);
  const selectedNode = useViewerStore((s) => s.selectedNode);

  const elements = useMemo(() => {
    if (!model) return [];
    let entries = [...model.elements.entries()];

    if (activeSlice) {
      const slice = model.slices.find((s) => s.name === activeSlice);
      if (slice) {
        const sliceRefs = new Set([
          ...slice.commands,
          ...slice.events,
          ...slice.readModels,
          ...slice.automations,
          ...slice.aggregates,
          ...slice.screens,
          ...slice.externals,
          ...slice.sagas,
        ]);
        entries = entries.filter(([name]) => sliceRefs.has(name));
      }
    }

    if (activeKind) {
      entries = entries.filter(([, el]) => el.kind === activeKind);
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      entries = entries.filter(
        ([name, el]) => name.toLowerCase().includes(q) || el.description?.toLowerCase().includes(q),
      );
    }

    return entries;
  }, [model, activeKind, activeSlice, searchQuery]);

  if (!model) return null;

  const grouped = new Map<ElementKind, [string, ElementDef][]>();
  for (const entry of elements) {
    const kind = entry[1].kind;
    const arr = grouped.get(kind) ?? [];
    arr.push(entry);
    grouped.set(kind, arr);
  }

  return (
    <ScrollArea edgeFade className="h-full">
      <div className="space-y-6 p-4">
        <p className="text-muted-foreground text-sm">
          {elements.length} element{elements.length !== 1 ? 's' : ''}
        </p>

        {(
          [
            'command',
            'event',
            'aggregate',
            'readModel',
            'screen',
            'automation',
            'external',
            'saga',
          ] as ElementKind[]
        ).map((kind) => {
          const items = grouped.get(kind);
          if (!items || items.length === 0) return null;

          return (
            <div key={kind}>
              <h3 className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider">
                <span>{EVFLOW_ICONS[kind]}</span>
                <span>{KIND_LABELS[kind]}s</span>
                <span className="text-muted-foreground/50">({items.length})</span>
              </h3>
              <div className="space-y-1">
                {items.map(([name, el]) => (
                  <Button
                    key={name}
                    variant={selectedNode === name ? 'secondary' : 'ghost'}
                    size="sm"
                    onClick={() =>
                      setSelectedNode(
                        name
                          .replace(/[^a-zA-Z0-9]/g, '_')
                          .replace(/_+/g, '_')
                          .replace(/^_|_$/g, ''),
                      )
                    }
                    className="h-auto w-full flex-col items-start justify-start px-3 py-2"
                    data-testid={`viewer-element-${name}`}
                  >
                    <span className="text-sm font-medium">{name}</span>
                    {el.description && (
                      <span className="text-muted-foreground mt-0.5 w-full truncate text-left text-xs">
                        {el.description}
                      </span>
                    )}
                    {'fields' in el && el.fields && (
                      <span className="text-muted-foreground/60 mt-0.5 text-xs">
                        {Object.keys(el.fields as Record<string, string>).length} fields
                      </span>
                    )}
                  </Button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}
