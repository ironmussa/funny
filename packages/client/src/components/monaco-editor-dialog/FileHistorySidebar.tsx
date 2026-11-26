import { History } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ScrollArea } from '@/components/ui/scroll-area';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { formatBlameLineRanges, type BlameHistoryEntry } from '@/lib/editor-blame-history';
import { timeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';

export function FileHistorySidebar({
  entries,
  onSelect,
}: {
  entries: BlameHistoryEntry[];
  onSelect: (entry: BlameHistoryEntry) => void;
}) {
  const { t } = useTranslation();
  const now = useMinuteTick();
  return (
    <aside
      className="border-border bg-sidebar/70 hidden w-[290px] shrink-0 border-l lg:flex lg:flex-col"
      data-testid="editor-history-sidebar"
    >
      <div className="border-border shrink-0 border-b px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <History className="icon-sm text-muted-foreground" />
          <span>{t('editor.historyTitle', 'File history')}</span>
        </div>
        <div className="text-muted-foreground mt-1 text-xs">
          {t('editor.historyDescription', 'Commits touching the current file')}
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 p-2">
          {entries.map((entry) => (
            <button
              key={entry.commitHash}
              type="button"
              className={cn(
                'hover:bg-accent focus-visible:ring-ring w-full rounded-md px-2.5 py-2 text-left',
                'focus-visible:ring-2 focus-visible:outline-none',
              )}
              onClick={() => onSelect(entry)}
              data-testid={`editor-history-entry-${entry.shortHash}`}
            >
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-medium">{entry.author}</span>
                <span className="text-muted-foreground text-compact shrink-0 font-mono">
                  {entry.shortHash}
                </span>
              </div>
              <div className="text-muted-foreground mt-0.5 flex min-w-0 items-center gap-1 text-xs">
                <span className="truncate">
                  {entry.authoredAt === null
                    ? t('editor.uncommitted', 'Uncommitted')
                    : timeAgo(entry.authoredAt, t, now)}
                </span>
                <span aria-hidden="true">-</span>
                <span className="shrink-0">{formatHistoryMeta(entry, t)}</span>
              </div>
              <div className="mt-1 line-clamp-2 text-xs">{entry.summary}</div>
              {entry.ranges.length > 0 ? (
                <div className="text-muted-foreground text-compact mt-1 truncate font-mono">
                  {formatBlameLineRanges(entry.ranges)}
                </div>
              ) : (
                <div className="text-muted-foreground text-compact mt-1 truncate">
                  {formatHistoryPath(entry)}
                </div>
              )}
            </button>
          ))}
        </div>
      </ScrollArea>
    </aside>
  );
}

function formatHistoryMeta(entry: BlameHistoryEntry, t: ReturnType<typeof useTranslation>['t']) {
  if (entry.lineCount > 0) {
    return t('editor.historyLineCount', '{{count}} lines', { count: entry.lineCount });
  }
  return t('editor.historyFileEvent', 'file event');
}

function formatHistoryPath(entry: BlameHistoryEntry): string {
  if (entry.status === 'renamed' && entry.previousPath) {
    return `${entry.previousPath} -> ${entry.path ?? ''}`;
  }
  return entry.path ?? '';
}
