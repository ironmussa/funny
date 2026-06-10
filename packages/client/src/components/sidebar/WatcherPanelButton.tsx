import type { Job, JobStatus, Watcher, WatcherStatus } from '@funny/shared';
import { AlarmClock, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NavItem } from '@/components/ui/nav-item';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { ACTIVE_WATCHER_STATUSES as ACTIVE_STATUSES, formatCountdown } from '@/lib/watcher-utils';
import { useJobStore } from '@/stores/job-store';
import { useWatcherStore } from '@/stores/watcher-store';

function statusLabel(w: Watcher): string {
  switch (w.status) {
    case 'pending':
      return 'pending';
    case 'fired':
      return 'woke agent';
    case 'done':
      return 'concluded';
    case 'cancelled':
      return 'cancelled';
    case 'expired':
      // Distinguish the two terminal causes from the data we have.
      return w.wakeCount >= w.maxWakes ? 'hit wake limit' : 'timed out';
    default:
      return w.status;
  }
}

function statusVariant(status: WatcherStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'pending':
      return 'default';
    case 'fired':
      return 'secondary';
    case 'expired':
      return 'destructive';
    default:
      return 'outline';
  }
}

function WatcherRow({ watcher, now }: { watcher: Watcher; now: number }) {
  const cancelWatcher = useWatcherStore((s) => s.cancelWatcher);
  const isActive = ACTIVE_STATUSES.includes(watcher.status);

  return (
    <div
      className="hover:bg-accent flex items-start justify-between gap-2 rounded-md px-2 py-1.5"
      data-testid={`watcher-row-${watcher.id}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{watcher.label}</span>
          <Badge variant={statusVariant(watcher.status)} className="shrink-0 text-[10px]">
            {statusLabel(watcher)}
          </Badge>
        </div>
        <p className="text-muted-foreground truncate text-xs">
          {watcher.status === 'pending' ? formatCountdown(watcher.nextWakeAt, now) : null}
          {watcher.status === 'pending' ? ' · ' : null}
          checked {watcher.wakeCount}×{watcher.maxWakes ? ` / ${watcher.maxWakes}` : ''}
        </p>
      </div>
      {isActive ? (
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground size-6 shrink-0"
          data-testid={`watcher-cancel-${watcher.id}`}
          onClick={() => void cancelWatcher(watcher.id)}
          aria-label="Cancel watcher"
        >
          <X className="icon-sm" />
        </Button>
      ) : null}
    </div>
  );
}

function jobStatusLabel(j: Job): string {
  switch (j.status) {
    case 'running':
      return 'running';
    case 'exited':
      return 'done';
    case 'failed':
      return `failed (${j.exitCode ?? '?'})`;
    case 'killed':
      return 'killed';
    case 'cancelled':
      return 'cancelled';
    default:
      return j.status;
  }
}

function jobStatusVariant(status: JobStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'running':
      return 'default';
    case 'failed':
    case 'killed':
      return 'destructive';
    default:
      return 'outline';
  }
}

function JobRow({ job }: { job: Job }) {
  const cancelJob = useJobStore((s) => s.cancelJob);
  return (
    <div
      className="hover:bg-accent flex items-start justify-between gap-2 rounded-md px-2 py-1.5"
      data-testid={`job-row-${job.id}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{job.label || job.command}</span>
          <Badge variant={jobStatusVariant(job.status)} className="shrink-0 text-[10px]">
            {jobStatusLabel(job)}
          </Badge>
        </div>
        <p className="text-muted-foreground truncate font-mono text-xs">{job.command}</p>
      </div>
      {job.status === 'running' ? (
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground size-6 shrink-0"
          data-testid={`job-cancel-${job.id}`}
          onClick={() => void cancelJob(job.id)}
          aria-label="Cancel job"
        >
          <X className="icon-sm" />
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Global, cross-thread background-activity panel. Lists the user's running
 * jobs (funny_spawn) and deferred-wake watchers (funny_watch snooze) with live
 * status (fed by `job:*` / `watcher:*` WS events) and cancel controls.
 */
export function WatcherPanelButton() {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const watchersById = useWatcherStore((s) => s.watchersById);
  const loadWatchers = useWatcherStore((s) => s.loadWatchers);
  const jobsById = useJobStore((s) => s.jobsById);
  const loadJobs = useJobStore((s) => s.loadJobs);

  const watchers = useMemo(() => {
    const rank = (s: WatcherStatus) => (ACTIVE_STATUSES.includes(s) ? 0 : 1);
    return Object.values(watchersById).sort(
      (a, b) => rank(a.status) - rank(b.status) || b.createdAt.localeCompare(a.createdAt),
    );
  }, [watchersById]);

  const jobs = useMemo(() => {
    return Object.values(jobsById).sort(
      (a, b) =>
        (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) ||
        b.startedAt.localeCompare(a.startedAt),
    );
  }, [jobsById]);

  const activeCount = useMemo(
    () =>
      watchers.filter((w) => ACTIVE_STATUSES.includes(w.status)).length +
      jobs.filter((j) => j.status === 'running').length,
    [watchers, jobs],
  );

  // Load once on mount so the per-thread clocks (ThreadWatcherIndicator) are
  // correct without the user opening the panel. WS job:*/watcher:* events keep
  // the stores live afterwards. This button is always mounted in the sidebar
  // footer, so this populates the stores app-wide.
  useEffect(() => {
    void loadWatchers();
    void loadJobs();
  }, [loadWatchers, loadJobs]);

  // Fetch on open; tick the countdown every second while open.
  useEffect(() => {
    if (!open) return;
    void loadWatchers();
    void loadJobs();
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, loadWatchers, loadJobs]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <NavItem
          icon={AlarmClock}
          label="Watchers"
          count={activeCount}
          isActive={open}
          data-testid="sidebar-watchers"
        />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 p-1" data-testid="watcher-panel">
        {jobs.length === 0 && watchers.length === 0 ? (
          <p className="text-muted-foreground px-2 py-4 text-center text-sm">
            No background activity yet.
          </p>
        ) : (
          <ScrollArea className={cn('max-h-96', jobs.length + watchers.length > 6 && 'h-96')}>
            {jobs.length > 0 && (
              <>
                <div className="text-muted-foreground px-2 py-1.5 text-xs font-medium">
                  Background jobs
                </div>
                <div className="flex flex-col gap-0.5">
                  {jobs.map((j) => (
                    <JobRow key={j.id} job={j} />
                  ))}
                </div>
              </>
            )}
            {watchers.length > 0 && (
              <>
                <div className="text-muted-foreground px-2 py-1.5 text-xs font-medium">
                  Watchers
                </div>
                <div className="flex flex-col gap-0.5">
                  {watchers.map((w) => (
                    <WatcherRow key={w.id} watcher={w} now={now} />
                  ))}
                </div>
              </>
            )}
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  );
}
