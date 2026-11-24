import type { WSTestConsoleData } from '@funny/shared';
import { useMemo } from 'react';

import {
  DetailTooltip,
  shortenUrl,
  useFollowScroll,
  withStableOccurrenceKeys,
} from '@/components/test-runner/detail-tabs/shared';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

const CONSOLE_LEVEL_STYLES: Record<string, string> = {
  error: 'text-status-error',
  warn: 'text-status-warning',
  info: 'text-status-info',
  debug: 'text-muted-foreground',
  trace: 'text-muted-foreground',
  log: '',
};

const CONSOLE_LEVEL_ICONS: Record<string, string> = {
  error: 'x',
  warn: '!',
  info: 'i',
  debug: 'd',
  log: '>',
  trace: 't',
};

export function ConsoleTab({ entries }: { entries: WSTestConsoleData[] }) {
  const keyedEntries = useMemo(
    () =>
      withStableOccurrenceKeys(
        entries,
        ({ column, level, line, text, timestamp, url }) =>
          `${timestamp}\u0000${level}\u0000${url ?? ''}\u0000${line ?? ''}\u0000${column ?? ''}\u0000${text}`,
      ),
    [entries],
  );

  const { ref, handleScroll } = useFollowScroll(entries.length);

  return (
    <ScrollArea
      viewportRef={ref}
      viewportProps={{ onScroll: handleScroll }}
      className="h-full font-mono text-xs"
    >
      {entries.length === 0 ? (
        <div className="text-muted-foreground flex h-full items-center justify-center">
          Browser console messages will appear here…
        </div>
      ) : (
        <div>
          {keyedEntries.map(({ key, value: entry }) => (
            <div
              key={key}
              className={cn(
                'flex items-start gap-2 border-b border-border/30 px-3 py-1',
                CONSOLE_LEVEL_STYLES[entry.level] ?? '',
              )}
            >
              <span className="mt-0.5 w-3 shrink-0 text-center font-bold opacity-60">
                {CONSOLE_LEVEL_ICONS[entry.level] ?? '>'}
              </span>
              <span className="min-w-0 flex-1 break-all whitespace-pre-wrap">{entry.text}</span>
              {entry.url && (
                <DetailTooltip label={entry.url}>
                  <span className="text-muted-foreground shrink-0">
                    {shortenUrl(entry.url)}
                    {entry.line != null ? `:${entry.line}` : ''}
                  </span>
                </DetailTooltip>
              )}
            </div>
          ))}
        </div>
      )}
    </ScrollArea>
  );
}
