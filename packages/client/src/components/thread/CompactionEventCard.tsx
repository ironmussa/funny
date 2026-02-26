/**
 * CompactionEventCard — Inline card for context compaction events.
 * Displayed in the thread chat timeline when the agent's context window is compacted.
 */

import { Minimize2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { timeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';
import type { CompactionEvent } from '@/stores/thread-store';

export function CompactionEventCard({ event }: { event: CompactionEvent }) {
  const { t } = useTranslation();
  const tokenK = Math.round(event.preTokens / 1000);

  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2 text-xs flex items-center gap-2',
        'border-amber-500/20 bg-amber-500/5',
      )}
    >
      <Minimize2 className="h-3.5 w-3.5 shrink-0 text-amber-600" />
      <span className="font-medium shrink-0 text-amber-600">Context compacted</span>
      <span className="text-muted-foreground">
        {tokenK}K tokens → summarized ({event.trigger})
      </span>
      {event.timestamp && (
        <span className="ml-auto shrink-0 text-muted-foreground">
          {timeAgo(event.timestamp, t)}
        </span>
      )}
    </div>
  );
}
