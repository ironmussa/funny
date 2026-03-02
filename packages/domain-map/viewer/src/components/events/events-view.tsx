import { AlertTriangle, XCircle } from 'lucide-react';
import { useMemo } from 'react';

import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { buildEventInfo } from '@/lib/transform';
import { useDomainStore } from '@/stores/domain-store';
import type { EventInfo } from '@/types/domain';

export function EventsView() {
  const graph = useDomainStore((s) => s.graph);

  const { families, orphans, deadLetters } = useMemo(() => {
    if (!graph)
      return {
        families: new Map<string, EventInfo[]>(),
        orphans: [] as EventInfo[],
        deadLetters: [] as EventInfo[],
      };

    const events = buildEventInfo(graph);
    const familyMap = new Map<string, EventInfo[]>();
    for (const evt of events) {
      if (!familyMap.has(evt.family)) familyMap.set(evt.family, []);
      familyMap.get(evt.family)!.push(evt);
    }

    return {
      families: familyMap,
      orphans: events.filter((e) => e.isOrphan),
      deadLetters: events.filter((e) => e.isDeadLetter),
    };
  }, [graph]);

  if (!graph) return null;

  const sortedFamilies = [...families.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <ScrollArea className="h-full" data-testid="events-view">
      <div className="space-y-6 p-4">
        <div className="flex flex-wrap gap-6">
          {sortedFamilies.map(([family, events]) => (
            <div key={family} className="min-w-[320px] flex-1">
              <h3 className="mb-2 text-sm font-semibold">
                {family} <span className="text-muted-foreground">({events.length} events)</span>
              </h3>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-1.5 pr-3">Event</th>
                    <th className="py-1.5 pr-3">Producers</th>
                    <th className="py-1.5 pr-3">Consumers</th>
                    <th className="py-1.5">Cross-SD</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((evt) => (
                    <tr
                      key={evt.event}
                      className={`border-b border-border/50 ${
                        evt.isOrphan ? 'bg-red-50 dark:bg-red-950/20' : ''
                      }`}
                    >
                      <td className="py-1.5 pr-3 font-mono">
                        {evt.isOrphan && (
                          <AlertTriangle className="mr-1 inline h-3 w-3 text-red-500" />
                        )}
                        {evt.event}
                      </td>
                      <td className="py-1.5 pr-3">
                        {evt.emitters.map((e) => e.name).join(', ') || (
                          <span className="italic text-muted-foreground">none</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3">
                        {evt.consumers.map((c) => c.name).join(', ') || (
                          <span className="italic text-muted-foreground">none</span>
                        )}
                      </td>
                      <td className="py-1.5">
                        {evt.isCrossSubdomain && (
                          <Badge variant="outline" className="text-[10px]">
                            Yes
                          </Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>

        {orphans.length > 0 && (
          <div>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-red-600 dark:text-red-400">
              <AlertTriangle className="h-4 w-4" />
              Orphan Events ({orphans.length})
            </h3>
            <p className="text-xs text-muted-foreground">
              Emitted but never consumed:{' '}
              {orphans.map((e) => (
                <code
                  key={e.event}
                  className="mr-1 rounded bg-red-100 px-1 py-0.5 text-red-800 dark:bg-red-900/30 dark:text-red-300"
                >
                  {e.event}
                </code>
              ))}
            </p>
          </div>
        )}

        {deadLetters.length > 0 && (
          <div>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-orange-600 dark:text-orange-400">
              <XCircle className="h-4 w-4" />
              Dead Letters ({deadLetters.length})
            </h3>
            <p className="text-xs text-muted-foreground">
              Consumed but never emitted:{' '}
              {deadLetters.map((e) => (
                <code
                  key={e.event}
                  className="mr-1 rounded bg-orange-100 px-1 py-0.5 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300"
                >
                  {e.event}
                </code>
              ))}
            </p>
          </div>
        )}

        {orphans.length === 0 && deadLetters.length === 0 && (
          <p className="text-sm text-emerald-600 dark:text-emerald-400">
            All events have at least one producer and one consumer.
          </p>
        )}
      </div>
    </ScrollArea>
  );
}
