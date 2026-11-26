import { X } from 'lucide-react';
import { useMemo } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';

import { EVFLOW_ICONS } from '../../../src/generators/react-flow';
import type { ElementKind } from '../../../src/types';
import { useViewerStore } from '../stores/viewer-store';
import { SelectedElementDetails } from './sidebar-selected-element';

const ALL_KINDS: ElementKind[] = [
  'command',
  'event',
  'aggregate',
  'readModel',
  'screen',
  'automation',
  'external',
  'saga',
];

const KIND_LABEL: Record<ElementKind, string> = {
  command: 'Cmd',
  event: 'Evt',
  aggregate: 'Agg',
  readModel: 'RM',
  screen: 'Scr',
  automation: 'Auto',
  external: 'Ext',
  saga: 'Saga',
};

export function Sidebar() {
  const model = useViewerStore((s) => s.model);
  const activeSlice = useViewerStore((s) => s.activeSlice);
  const activeKind = useViewerStore((s) => s.activeKind);
  const searchQuery = useViewerStore((s) => s.searchQuery);
  const setActiveSlice = useViewerStore((s) => s.setActiveSlice);
  const setActiveKind = useViewerStore((s) => s.setActiveKind);
  const setSearchQuery = useViewerStore((s) => s.setSearchQuery);
  const selectedNode = useViewerStore((s) => s.selectedNode);
  const setSelectedNode = useViewerStore((s) => s.setSelectedNode);
  const fetchSource = useViewerStore((s) => s.fetchSource);

  const kindCounts = useMemo(() => {
    if (!model) return new Map<ElementKind, number>();
    const counts = new Map<ElementKind, number>();

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
        for (const [name, el] of model.elements) {
          if (sliceRefs.has(name)) {
            counts.set(el.kind, (counts.get(el.kind) ?? 0) + 1);
          }
        }
      }
    } else {
      for (const el of model.elements.values()) {
        counts.set(el.kind, (counts.get(el.kind) ?? 0) + 1);
      }
    }
    return counts;
  }, [model, activeSlice]);

  const searchResults = useMemo(() => {
    if (!model || !searchQuery) return [];
    const q = searchQuery.toLowerCase();
    return [...model.elements.entries()].filter(
      ([name, el]) => name.toLowerCase().includes(q) || el.description?.toLowerCase().includes(q),
    );
  }, [model, searchQuery]);

  if (!model) return null;

  const selectedEl = selectedNode
    ? [...model.elements.entries()].find(([, el]) => {
        const id = el.name
          .replace(/[^a-zA-Z0-9]/g, '_')
          .replace(/_+/g, '_')
          .replace(/^_|_$/g, '');
        return id === selectedNode;
      })
    : null;

  return (
    <div
      className="flex h-full w-64 flex-col overflow-hidden border-r"
      data-testid="viewer-sidebar"
    >
      {/* Header */}
      <div className="p-3">
        <h2 className="truncate text-sm font-semibold">{model.name}</h2>
        <p className="text-muted-foreground mt-0.5 text-xs">{model.elements.size} elements</p>
      </div>

      <Separator />

      {/* Search */}
      <div className="p-2">
        <div className="relative">
          <Input
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSelectedNode(null);
            }}
            placeholder="Search nodes & connections..."
            className="h-8 pr-7 text-xs"
            data-testid="viewer-search"
          />
          {searchQuery && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setSearchQuery('')}
              className="absolute top-1/2 right-1 -translate-y-1/2"
              data-testid="viewer-search-clear"
            >
              <X className="h-3 w-3" />
            </Button>
          )}
        </div>
        {searchQuery && searchResults.length > 0 && (
          <div className="mt-1 max-h-40 space-y-0.5 overflow-y-auto">
            <p className="text-muted-foreground mb-0.5 text-[10px]">
              {searchResults.length} match{searchResults.length !== 1 ? 'es' : ''} — highlighted in
              graph
            </p>
            {searchResults.map(([name, el]) => (
              <Button
                key={name}
                variant="ghost"
                size="xs"
                onClick={() => {
                  const id = name
                    .replace(/[^a-zA-Z0-9]/g, '_')
                    .replace(/_+/g, '_')
                    .replace(/^_|_$/g, '');
                  setSelectedNode(id);
                }}
                className="h-auto w-full justify-start gap-1 px-1.5 py-1 text-[11px]"
                data-testid={`viewer-search-result-${name}`}
              >
                <span>{EVFLOW_ICONS[el.kind]}</span>
                <span className="truncate">{name}</span>
              </Button>
            ))}
          </div>
        )}
        {searchQuery && searchResults.length === 0 && (
          <p className="text-muted-foreground/60 mt-1 text-[10px]">No matches</p>
        )}
      </div>

      <Separator />

      {/* Kind filters */}
      <div className="p-2">
        <div className="mb-1.5 flex items-center gap-1">
          <span className="text-muted-foreground text-[10px] tracking-wider uppercase">Kind</span>
          {activeSlice && activeKind && (
            <span className="ml-auto text-[10px] text-amber-500/70">highlighting</span>
          )}
        </div>
        <div className="flex flex-wrap gap-1">
          <Button
            variant={!activeKind ? 'secondary' : 'ghost'}
            size="xs"
            onClick={() => setActiveKind(null)}
            className="h-6 px-1.5 text-[10px]"
            data-testid="viewer-kind-all"
          >
            All
          </Button>
          {ALL_KINDS.map((kind) => {
            const count = kindCounts.get(kind) ?? 0;
            if (count === 0) return null;
            return (
              <Button
                key={kind}
                variant={activeKind === kind ? 'secondary' : 'ghost'}
                size="xs"
                onClick={() => setActiveKind(activeKind === kind ? null : kind)}
                className="h-6 px-1.5 text-[10px]"
                title={`${KIND_LABEL[kind]} (${count})`}
                data-testid={`viewer-kind-${kind}`}
              >
                {EVFLOW_ICONS[kind]} {count}
              </Button>
            );
          })}
        </div>
      </div>

      <Separator />

      {/* Slice filters */}
      {model.slices.length > 0 && (
        <>
          <div className="p-2">
            <span className="text-muted-foreground mb-1.5 block text-[10px] tracking-wider uppercase">
              Slices
            </span>
            <div className="space-y-0.5">
              <Button
                variant={!activeSlice ? 'secondary' : 'ghost'}
                size="xs"
                onClick={() => {
                  setActiveSlice(null);
                  setActiveKind(null);
                }}
                className="w-full justify-start"
                data-testid="viewer-slice-all"
              >
                All slices
              </Button>
              {model.slices.map((slice) => (
                <Button
                  key={slice.name}
                  variant={activeSlice === slice.name ? 'secondary' : 'ghost'}
                  size="xs"
                  onClick={() => {
                    setActiveSlice(activeSlice === slice.name ? null : slice.name);
                    setActiveKind(null);
                  }}
                  className="w-full justify-start"
                  data-testid={`viewer-slice-${slice.name}`}
                >
                  {slice.name}
                </Button>
              ))}
            </div>
          </div>
          <Separator />
        </>
      )}

      {/* Selected element details */}
      {selectedEl && (
        <SelectedElementDetails
          name={selectedEl[0]}
          el={selectedEl[1]}
          onClear={() => setSelectedNode(null)}
          onOpenSource={fetchSource}
        />
      )}
    </div>
  );
}
