import type { WSTestErrorData } from '@funny/shared';
import { AlertTriangle } from 'lucide-react';
import { useMemo } from 'react';

import { withStableOccurrenceKeys } from '@/components/test-runner/detail-tabs/shared';
import { EmptyState } from '@/components/ui/empty-state';
import { ScrollArea } from '@/components/ui/scroll-area';

export function ErrorsTab({ entries }: { entries: WSTestErrorData[] }) {
  const keyedEntries = useMemo(
    () =>
      withStableOccurrenceKeys(
        entries,
        ({ column, line, message, source, stack, timestamp }) =>
          `${timestamp}\u0000${source ?? ''}\u0000${line ?? ''}\u0000${column ?? ''}\u0000${message}\u0000${stack ?? ''}`,
      ),
    [entries],
  );

  return (
    <ScrollArea className="h-full font-mono text-xs">
      {entries.length === 0 ? (
        <EmptyState title="No errors captured" />
      ) : (
        <div>
          {keyedEntries.map(({ key, value: entry }) => (
            <div key={key} className="border-border/30 border-b px-3 py-2">
              <div className="text-status-error flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                <span className="break-all whitespace-pre-wrap">{entry.message}</span>
              </div>
              {entry.source && (
                <div className="text-muted-foreground mt-1 ml-5">
                  {entry.source}
                  {entry.line != null ? `:${entry.line}` : ''}
                  {entry.column != null ? `:${entry.column}` : ''}
                </div>
              )}
              {entry.stack && (
                <pre className="text-muted-foreground/80 mt-1 ml-5 whitespace-pre-wrap">
                  {entry.stack}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </ScrollArea>
  );
}
