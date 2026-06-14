import type { Job, JobStatus, Watcher, WatcherStatus } from '@funny/shared';
import { AlarmClock, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NavItem } from '@/components/ui/nav-item';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTerminalScope } from '@/hooks/use-terminal-scope';
import { openJobLogTerminal } from '@/lib/open-terminal-tab';
import { timeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';
import {
  ACTIVE_WATCHER_STATUSES as ACTIVE_STATUSES,
  formatClock,
  formatCountdown,
} from '@/lib/watcher-utils';
import { useJobStore } from '@/stores/job-store';
import { findThreadById } from '@/stores/store-bridge';
import { useWatcherStore } from '@/stores/watcher-store';

/** Compact pill used for status chips in the background-activity panel. */
const CHIP_CLASS = 'h-4 shrink-0 rounded px-1 py-0 text-[9px] leading-none font-medium';

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
  const { t } = useTranslation();
  const cancelWatcher = useWatcherStore((s) => s.cancelWatcher);
  const isActive = ACTIVE_STATUSES.includes(watcher.status);

  const isPending = watcher.status === 'pending';
  // Pending watchers count down to the next wake; concluded/fired ones show
  // when they last woke. Either way expose the exact "hora" on hover.
  const timing = isPending
    ? formatCountdown(watcher.nextWakeAt, now)
    : timeAgo(watcher.updatedAt, t);
  // Absolute fire timestamp, shown inline: when it will fire (pending) or last
  // fired (concluded/fired).
  const fireAt = isPending ? watcher.nextWakeAt : watcher.updatedAt;
  const fireLabel = `${isPending ? 'fires' : 'fired'} ${formatClock(fireAt)}`;
  const timingTitle = isPending
    ? `Next wake ${formatClock(watcher.nextWakeAt)} · created ${formatClock(watcher.createdAt)}`
    : `Last update ${formatClock(watcher.updatedAt)} · created ${formatClock(watcher.createdAt)}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="hover:bg-accent flex items-start justify-between gap-2 rounded-md px-2 py-1.5"
          data-testid={`watcher-row-${watcher.id}`}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium">{watcher.label}</span>
              <Badge variant={statusVariant(watcher.status)} className={CHIP_CLASS}>
                {statusLabel(watcher)}
              </Badge>
            </div>
            <p className="text-muted-foreground truncate text-xs">
              {timing ? `${timing} · ` : null}
              checked {watcher.wakeCount}×{watcher.maxWakes ? ` / ${watcher.maxWakes}` : ''}
            </p>
            <p className="text-muted-foreground/70 truncate text-xs">{fireLabel}</p>
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
      </TooltipTrigger>
      <TooltipContent>{timingTitle}</TooltipContent>
    </Tooltip>
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

function JobRow({
  job,
  scopeId,
  onOpened,
}: {
  job: Job;
  scopeId: string | null;
  onOpened: () => void;
}) {
  const { t } = useTranslation();
  const cancelJob = useJobStore((s) => s.cancelJob);
  const [confirmKill, setConfirmKill] = useState(false);

  const isRunning = job.status === 'running';

  // Open the job's output in the existing bottom terminal panel: tail -f while
  // running, the captured log once finished. Opened in the current scope so it
  // surfaces immediately; fall back to the job's thread project if no scope.
  const openLog = () => {
    const projectId = scopeId ?? findThreadById(job.threadId)?.projectId ?? null;
    if (!projectId) return;
    openJobLogTerminal({ job, projectId });
    onOpened();
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            onClick={openLog}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openLog();
              }
            }}
            className="hover:bg-accent flex cursor-pointer items-start justify-between gap-2 rounded-md px-2 py-1.5"
            data-testid={`job-row-${job.id}`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium">{job.label || job.command}</span>
                <Badge variant={jobStatusVariant(job.status)} className={CHIP_CLASS}>
                  {jobStatusLabel(job)}
                </Badge>
              </div>
              {/* Relative timing, same format as thread activity rows. */}
              <p className="text-muted-foreground truncate text-xs">
                started {timeAgo(job.startedAt, t)}
                {!isRunning ? ` · ended ${timeAgo(job.updatedAt, t)}` : null}
              </p>
              <p className="text-muted-foreground/70 truncate font-mono text-xs">{job.command}</p>
            </div>
            {isRunning ? (
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground size-6 shrink-0"
                data-testid={`job-cancel-${job.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmKill(true);
                }}
                aria-label="Kill job"
                title="Kill this process"
              >
                <X className="icon-sm" />
              </Button>
            ) : null}
          </div>
        </TooltipTrigger>
        {/* Absolute "hora" plus the click hint, for the whole card. */}
        <TooltipContent>
          <div>
            {`Started ${formatClock(job.startedAt)}${
              !isRunning ? ` · ended ${formatClock(job.updatedAt)}` : ''
            }`}
          </div>
          <div className="text-muted-foreground">Open output in the terminal panel</div>
        </TooltipContent>
      </Tooltip>
      <ConfirmDialog
        open={confirmKill}
        onOpenChange={setConfirmKill}
        title="Kill process?"
        description={`This stops the running process: ${job.label || job.command}`}
        confirmLabel="Kill"
        cancelLabel="Cancel"
        variant="destructive"
        onCancel={() => setConfirmKill(false)}
        onConfirm={() => {
          setConfirmKill(false);
          void cancelJob(job.id);
        }}
      />
    </>
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
  const { scopeId } = useTerminalScope();
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
                    <JobRow key={j.id} job={j} scopeId={scopeId} onOpened={() => setOpen(false)} />
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
