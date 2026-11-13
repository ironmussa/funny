import type { Job, JobStatus, Watcher, WatcherStatus } from '@funny/shared';
import { AlarmClock, CircleStop } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { LoadMoreSentinel } from '@/components/LoadMoreSentinel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { normalize } from '@/components/ui/highlight-text';
import { NavItem } from '@/components/ui/nav-item';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SearchBar } from '@/components/ui/search-bar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cancelJob, cancelWatcher } from '@/data/background/actions';
import { useJobsById, useWatchersById } from '@/data/background/hooks';
import { loadJobs, loadWatchers } from '@/data/background/loaders';
import { useTerminalScope } from '@/hooks/use-terminal-scope';
import { openJobLogTerminal } from '@/lib/open-terminal-tab';
import { timeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';
import {
  ACTIVE_WATCHER_STATUSES as ACTIVE_STATUSES,
  formatClock,
  formatCountdown,
} from '@/lib/watcher-utils';
import { findThreadById } from '@/stores/store-bridge';

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
  const isActive = ACTIVE_STATUSES.includes(watcher.status);

  const isPending = watcher.status === 'pending';
  // Pending watchers count down to the next wake; concluded/fired ones show
  // when they last woke. Either way expose the exact "hora" on hover.
  const timing = isPending
    ? formatCountdown(watcher.nextWakeAt, now)
    : timeAgo(watcher.updatedAt, t, now);
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
              aria-label="Stop watcher"
              title="Stop watcher"
            >
              <CircleStop className="icon-sm" />
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
  now,
  onOpened,
}: {
  job: Job;
  scopeId: string | null;
  now: number;
  onOpened: () => void;
}) {
  const { t } = useTranslation();
  const [confirmKill, setConfirmKill] = useState(false);

  const isRunning = job.status === 'running';

  // Open the job's captured output in the existing bottom terminal panel.
  // Opened in the current scope so it surfaces immediately; fall back to the
  // job's thread project if no scope.
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
            className="hover:bg-accent flex items-start justify-between gap-2 rounded-md px-2 py-1.5"
            data-testid={`job-row-${job.id}`}
          >
            <button
              type="button"
              onClick={openLog}
              className="focus-visible:ring-ring min-w-0 flex-1 cursor-pointer rounded-sm text-left outline-none focus-visible:ring-1"
              aria-label={`Open output for ${job.label || job.command}`}
            >
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium">{job.label || job.command}</span>
                <Badge variant={jobStatusVariant(job.status)} className={CHIP_CLASS}>
                  {jobStatusLabel(job)}
                </Badge>
              </div>
              {/* Relative timing, same format as thread activity rows. */}
              <p className="text-muted-foreground truncate text-xs">
                started {timeAgo(job.startedAt, t, now)}
                {!isRunning ? ` · ended ${timeAgo(job.updatedAt, t, now)}` : null}
              </p>
              <p className="text-muted-foreground/70 truncate font-mono text-xs">{job.command}</p>
            </button>
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
                aria-label="Stop process"
                title="Stop process"
              >
                <CircleStop className="icon-sm" />
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
        title="Stop process?"
        description={`This stops the running process: ${job.label || job.command}`}
        confirmLabel="Stop"
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

type ActivityEntry =
  | { kind: 'job'; id: string; job: Job; active: boolean; date: string; text: string }
  | { kind: 'watcher'; id: string; watcher: Watcher; active: boolean; date: string; text: string };

type ActivityFilter = 'all' | 'active' | 'history';

const PAGE_SIZE = 50;

/** Jobs and watchers in one list: active first, then newest first. */
function buildActivityEntries(
  jobsById: Record<string, Job>,
  watchersById: Record<string, Watcher>,
): ActivityEntry[] {
  const items: ActivityEntry[] = [
    ...Object.values(jobsById).map((job) => ({
      kind: 'job' as const,
      id: job.id,
      job,
      active: job.status === 'running',
      date: job.startedAt,
      text: `${job.label} ${job.command} ${job.status}`,
    })),
    ...Object.values(watchersById).map((watcher) => ({
      kind: 'watcher' as const,
      id: watcher.id,
      watcher,
      active: ACTIVE_STATUSES.includes(watcher.status),
      date: watcher.createdAt,
      text: `${watcher.label} ${statusLabel(watcher)}`,
    })),
  ];
  return items.sort((a, b) => Number(b.active) - Number(a.active) || b.date.localeCompare(a.date));
}

function matchesActivity(entry: ActivityEntry, filter: ActivityFilter, query: string): boolean {
  if (filter !== 'all' && entry.active !== (filter === 'active')) return false;
  return normalize(entry.text).includes(normalize(query.trim()));
}

function ActivityEntryList({
  items,
  scopeId,
  now,
  onOpened,
}: {
  items: ActivityEntry[];
  scopeId: string | null;
  now: number;
  onOpened: () => void;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {items.map((entry, index) => (
        <div key={`${entry.kind}-${entry.id}`}>
          {(index === 0 || entry.active !== items[index - 1].active) && (
            <div className="text-muted-foreground px-2 py-2 text-xs font-medium">
              {entry.active ? 'Active' : 'History'}
            </div>
          )}
          {entry.kind === 'job' ? (
            <JobRow job={entry.job} scopeId={scopeId} now={now} onOpened={onOpened} />
          ) : (
            <WatcherRow watcher={entry.watcher} now={now} />
          )}
        </div>
      ))}
    </div>
  );
}

/** Full-history view with search, status filter and incremental paging. */
function WatchersDialog({
  open,
  onOpenChange,
  entries,
  activeCount,
  scopeId,
  now,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: ActivityEntry[];
  activeCount: number;
  scopeId: string | null;
  now: number;
}) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const totalCount = entries.length;
  const filtered = entries.filter((entry) => matchesActivity(entry, filter, search));
  const filterLabels: Record<ActivityFilter, string> = {
    all: `All (${totalCount})`,
    active: `Active (${activeCount})`,
    history: `History (${totalCount - activeCount})`,
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[85dvh] max-w-4xl flex-col gap-0 overflow-hidden p-0"
        data-testid="watchers-view"
      >
        <DialogHeader className="border-border border-b px-5 py-4">
          <DialogTitle>Watchers</DialogTitle>
        </DialogHeader>
        <div className="border-border space-y-3 border-b px-5 py-3">
          <SearchBar
            query={search}
            onQueryChange={(value) => {
              setSearch(value);
              setVisibleCount(PAGE_SIZE);
            }}
            totalMatches={filtered.length}
            placeholder="Search watchers and commands…"
            testIdPrefix="watchers-search"
          />
          <div className="flex gap-2" role="group" aria-label="Activity status">
            {(['all', 'active', 'history'] as const).map((value) => (
              <Button
                key={value}
                size="sm"
                variant={filter === value ? 'secondary' : 'ghost'}
                aria-pressed={filter === value}
                data-testid={`watchers-filter-${value}`}
                onClick={() => {
                  setFilter(value);
                  setVisibleCount(PAGE_SIZE);
                }}
              >
                {filterLabels[value]}
              </Button>
            ))}
          </div>
        </div>
        <ScrollArea className="min-h-0 flex-1 px-3 py-2">
          {filtered.length === 0 ? (
            <EmptyState fill={false} className="py-12" title="No matching background activity." />
          ) : (
            <ActivityEntryList
              items={filtered.slice(0, visibleCount)}
              scopeId={scopeId}
              now={now}
              onOpened={() => onOpenChange(false)}
            />
          )}
          <LoadMoreSentinel
            hasMore={filtered.length > visibleCount}
            itemCount={Math.min(visibleCount, filtered.length)}
            onLoadMore={() => setVisibleCount((count) => count + PAGE_SIZE)}
            testId="watchers-load-more"
          />
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Global, cross-thread background-activity panel. Lists the user's running
 * jobs (funny_spawn) and deferred-wake watchers (funny_watch snooze) with live
 * status (fed by `job:*` / `watcher:*` WS events) and cancel controls.
 */
export function WatcherPanelButton() {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const { scopeId } = useTerminalScope();
  const watchersById = useWatchersById();
  const jobsById = useJobsById();

  const entries = useMemo(
    () => buildActivityEntries(jobsById, watchersById),
    [jobsById, watchersById],
  );
  const activeCount = entries.filter((entry) => entry.active).length;
  const totalCount = entries.length;

  // Load once on mount so the per-thread clocks (ThreadWatcherIndicator) are
  // correct without the user opening the panel. WS job:*/watcher:* events keep
  // the stores live afterwards. This button is always mounted in the sidebar
  // footer, so this populates the stores app-wide.
  useEffect(() => {
    void loadWatchers();
    void loadJobs();
  }, []);

  // Fetch on open; tick the countdown every second while open.
  useEffect(() => {
    if (!open && !showAll) return;
    void loadWatchers();
    void loadJobs();
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, showAll]);

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <NavItem
            icon={AlarmClock}
            label="Watchers"
            count={activeCount}
            isActive={open || showAll}
            data-testid="sidebar-watchers"
          />
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-80 p-1" data-testid="watcher-panel">
          <div className="border-border border-b px-2 py-2">
            <p className="text-sm font-medium">Watchers</p>
            <p className="text-muted-foreground text-xs">
              {activeCount} active · {totalCount - activeCount} in history
            </p>
          </div>
          {totalCount === 0 ? (
            <EmptyState fill={false} className="px-2 py-4" title="No background activity yet." />
          ) : (
            <>
              <ScrollArea className={cn('max-h-96', totalCount > 6 && 'h-96')}>
                <ActivityEntryList
                  items={entries.slice(0, 10)}
                  scopeId={scopeId}
                  now={now}
                  onOpened={() => setOpen(false)}
                />
              </ScrollArea>
              <Button
                variant="ghost"
                className="mt-1 w-full border-t"
                data-testid="watcher-panel-view-all"
                onClick={() => {
                  setOpen(false);
                  setShowAll(true);
                }}
              >
                {totalCount > 10 ? `View more (${totalCount - 10})` : 'View all'}
              </Button>
            </>
          )}
        </PopoverContent>
      </Popover>
      <WatchersDialog
        open={showAll}
        onOpenChange={setShowAll}
        entries={entries}
        activeCount={activeCount}
        scopeId={scopeId}
        now={now}
      />
    </>
  );
}
