import { AlarmClock } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  formatCountdown,
  selectActiveWatchersForThread,
  selectRunningJobsForThread,
} from '@/lib/watcher-utils';
import { useJobStore } from '@/stores/job-store';
import { useWatcherStore } from '@/stores/watcher-store';

/**
 * Small clock shown next to a thread's status icon when the thread has
 * background activity funny is tracking: a RUNNING job (funny_spawn) or a
 * PENDING watcher (funny_watch snooze). Rendered inside ThreadStatusPin, so it
 * appears in every surface that shows a thread — sidebar, kanban cards, and the
 * virtual thread list — from one place.
 *
 * Returns null when there is no active background work, so layouts are
 * unaffected in the common case.
 */
export function ThreadWatcherIndicator({ threadId }: { threadId: string }) {
  const watchers = useWatcherStore(
    useShallow((s) => selectActiveWatchersForThread(s.watchersById, threadId)),
  );
  const jobs = useJobStore(useShallow((s) => selectRunningJobsForThread(s.jobsById, threadId)));
  const [now, setNow] = useState(() => Date.now());

  const hasActive = watchers.length > 0 || jobs.length > 0;
  const hasWatcher = watchers.length > 0;

  // Tick the countdown only while there's a pending watcher to count down to.
  useEffect(() => {
    if (!hasWatcher) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasWatcher]);

  const tooltip = useMemo(() => {
    if (!hasActive) return '';
    const parts: string[] = [];
    if (jobs.length > 0) {
      parts.push(`${jobs.length} background job${jobs.length === 1 ? '' : 's'} running`);
    }
    if (watchers.length > 0) {
      const next = [...watchers].sort((a, b) => a.nextWakeAt - b.nextWakeAt)[0];
      const noun = watchers.length === 1 ? 'watcher' : 'watchers';
      parts.push(`${watchers.length} ${noun} · next wake ${formatCountdown(next.nextWakeAt, now)}`);
    }
    return parts.join(' · ');
  }, [watchers, jobs, hasActive, now]);

  if (!hasActive) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="flex shrink-0 items-center"
          data-testid={`thread-watcher-indicator-${threadId}`}
        >
          {/* icon-sm to match the thread status icon in ThreadStatusPin */}
          <AlarmClock className={cn('icon-sm', 'text-amber-500')} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}
