import { useMemo } from 'react';

import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

import { EVFLOW_ICONS } from '../../../src/generators/react-flow';
import type { ElementKind } from '../../../src/types';
import { useViewerStore } from '../stores/viewer-store';

export function SequencesView() {
  const model = useViewerStore((s) => s.model);
  const activeSlice = useViewerStore((s) => s.activeSlice);

  const sequences = useMemo(() => {
    if (!model) return [];

    if (!activeSlice) return model.sequences;

    const slice = model.slices.find((s) => s.name === activeSlice);
    if (!slice) return model.sequences;

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

    return model.sequences.filter((seq) => seq.steps.some((step) => sliceRefs.has(step)));
  }, [model, activeSlice]);

  if (!model) return null;

  if (sequences.length === 0) {
    return (
      <div className="text-muted-foreground p-4 text-sm">
        {activeSlice ? `No sequences found for slice "${activeSlice}".` : 'No sequences defined.'}
      </div>
    );
  }

  const sliceRefs = (() => {
    if (!activeSlice || !model) return null;
    const slice = model.slices.find((s) => s.name === activeSlice);
    if (!slice) return null;
    return new Set([
      ...slice.commands,
      ...slice.events,
      ...slice.readModels,
      ...slice.automations,
      ...slice.aggregates,
      ...slice.screens,
      ...slice.externals,
      ...slice.sagas,
    ]);
  })();

  return (
    <ScrollArea edgeFade className="h-full">
      <div className="space-y-6 p-4">
        {sequences.map((seq) => (
          <div key={seq.name} className="space-y-2" data-testid={`viewer-sequence-${seq.name}`}>
            <h3 className="text-sm font-semibold">{seq.name}</h3>
            <div className="flex flex-wrap items-center gap-1">
              {seq.steps.map((step, i) => {
                const el = model.elements.get(step);
                const kind = el?.kind ?? 'command';
                const icon = EVFLOW_ICONS[kind as ElementKind] ?? '';
                const inSlice = !sliceRefs || sliceRefs.has(step);

                return (
                  <span key={`${seq.name}-${i}`} className="flex items-center gap-1">
                    <Badge
                      variant="outline"
                      className={cn('gap-1 font-normal', !inSlice && 'opacity-40')}
                    >
                      <span>{icon}</span>
                      <span>{step}</span>
                      <span className="text-muted-foreground text-[10px]">{kind}</span>
                    </Badge>
                    {i < seq.steps.length - 1 && (
                      <span className="text-muted-foreground/50 mx-0.5 text-xs">&rarr;</span>
                    )}
                  </span>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
