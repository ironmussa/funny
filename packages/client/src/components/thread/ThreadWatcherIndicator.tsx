import { AlarmClock, SquareTerminal, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useThreadJobsById, useThreadWatchersById } from '@/data/background/hooks';
import { cn } from '@/lib/utils';
import {
  formatCountdown,
  selectActiveWatchersForThread,
  selectRunningJobsForThread,
} from '@/lib/watcher-utils';

/**
 * Background activity funny is tracking for a thread, shown to the RIGHT of the
 * thread's title (sidebar, kanban cards, virtual thread list):
 *
 * - a terminal icon while a background job is RUNNING (funny_spawn);
 * - an alarm clock while a watcher is PENDING (funny_watch snooze), with the
 *   countdown to its next wake in the tooltip.
 *
 * Each kind has its own icon so the user can tell "a process is running" from
 * "the agent will wake up later". Renders nothing when there is no active
 * background work, so layouts are unaffected in the common case.
 */
export function ThreadWatcherIndicator({
  threadId,
  className,
}: {
  threadId: string;
  className?: string;
}) {
  const threadWatchers = useThreadWatchersById(threadId);
  const threadJobs = useThreadJobsById(threadId);
  const watchers = useMemo(
    () => selectActiveWatchersForThread(threadWatchers, threadId),
    [threadWatchers, threadId],
  );
  const jobs = useMemo(
    () => selectRunningJobsForThread(threadJobs, threadId),
    [threadJobs, threadId],
  );

  if (watchers.length === 0 && jobs.length === 0) return null;

  return (
    <span className={cn('flex shrink-0 items-center gap-1', className)}>
      {jobs.length > 0 && (
        <IndicatorIcon
          icon={SquareTerminal}
          className="text-status-info"
          testId={`thread-job-indicator-${threadId}`}
          tooltip={`${jobs.length} background job${jobs.length === 1 ? '' : 's'} running`}
        />
      )}
      {watchers.length > 0 && (
        <WatcherIcon
          threadId={threadId}
          count={watchers.length}
          nextWakeAt={Math.min(...watchers.map((w) => w.nextWakeAt))}
        />
      )}
    </span>
  );
}

/** The alarm clock, whose tooltip counts down to the next wake. */
function WatcherIcon({
  threadId,
  count,
  nextWakeAt,
}: {
  threadId: string;
  count: number;
  nextWakeAt: number;
}) {
  const [now, setNow] = useState(() => Date.now());

  // Tick the countdown only while this icon is mounted (a watcher is pending).
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const noun = count === 1 ? 'watcher' : 'watchers';
  return (
    <IndicatorIcon
      icon={AlarmClock}
      className="text-status-warning"
      testId={`thread-watcher-indicator-${threadId}`}
      tooltip={`${count} ${noun} · next wake ${formatCountdown(nextWakeAt, now)}`}
    />
  );
}

function IndicatorIcon({
  icon: GlyphIcon,
  className,
  testId,
  tooltip,
}: {
  icon: LucideIcon;
  className: string;
  testId: string;
  tooltip: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex shrink-0 items-center" data-testid={testId}>
          {/* icon-sm to match the thread status icon in ThreadStatusPin */}
          <GlyphIcon className={cn('icon-sm', className)} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  );
}
