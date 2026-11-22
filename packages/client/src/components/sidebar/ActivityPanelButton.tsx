import type { Activity, Job, JobStatus, Watcher, WatcherStatus } from '@funny/shared';
import { Activity as ActivityIcon, CircleStop } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { clearFinishedActivities, dismissActivity } from '@/data/activities/actions';
import { useActivities, useActivityCounts, useActivityProgress } from '@/data/activities/hooks';
import { loadActivities } from '@/data/activities/loaders';
import { cancelJob, cancelWatcher } from '@/data/background/actions';
import { useJobsById, useWatchersById } from '@/data/background/hooks';
import { loadJobs, loadWatchers } from '@/data/background/loaders';
import { useTerminalScope } from '@/hooks/use-terminal-scope';
import { canRetryActivity, retryActivity } from '@/lib/activity-retry';
import { openJobLogTerminal } from '@/lib/open-terminal-tab';
import { timeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';
import {
  ACTIVE_WATCHER_STATUSES as ACTIVE_STATUSES,
  formatClock,
  formatCountdown,
} from '@/lib/watcher-utils';
import { type ActivityPanelTab, useActivityPanelStore } from '@/stores/activity-panel-store';
import { useCloneRetryStore } from '@/stores/clone-retry-store';
import { useRunnerStatusStore } from '@/stores/runner-status-store';
import { findThreadById } from '@/stores/store-bridge';
import { useUIStore } from '@/stores/ui-store';

import { ActivityList } from './ActivityList';

/** Compact pill used for status chips in the background-activity panel. */
const CHIP_CLASS = 'h-4 shrink-0 rounded px-1 py-0 text-3xs leading-none font-medium';

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

/** One kind of background entry (jobs or watchers): a preview plus the full-history dialog. */
function BackgroundEntriesTab({
  kind,
  entries,
  scopeId,
  now,
  onOpened,
  onViewAll,
}: {
  kind: 'job' | 'watcher';
  entries: ActivityEntry[];
  scopeId: string | null;
  now: number;
  onOpened: () => void;
  onViewAll: () => void;
}) {
  const items = entries.filter((entry) => entry.kind === kind);
  const activeCount = items.filter((entry) => entry.active).length;
  return (
    <>
      <p className="text-muted-foreground px-2 pb-1 text-xs">
        {activeCount} active · {items.length - activeCount} in history
      </p>
      {items.length === 0 ? (
        <EmptyState fill={false} className="px-2 py-4" title="No background activity yet." />
      ) : (
        <>
          <ScrollArea className={cn('max-h-96', items.length > 6 && 'h-96')}>
            <ActivityEntryList
              items={items.slice(0, 10)}
              scopeId={scopeId}
              now={now}
              onOpened={onOpened}
            />
          </ScrollArea>
          <Button
            variant="ghost"
            className="mt-1 w-full border-t"
            data-testid={`${kind === 'job' ? 'jobs' : 'watcher'}-panel-view-all`}
            onClick={onViewAll}
          >
            {items.length > 10 ? `View more (${items.length - 10})` : 'View all'}
          </Button>
        </>
      )}
    </>
  );
}

/** Opens where a failed activity can be retried; true when something opened. */
function openRetryTarget(activity: Activity, navigate: (path: string) => void): boolean {
  return retryActivity(activity, {
    navigate,
    findThread: (threadId) => findThreadById(threadId),
    openCloneForm: (values) => {
      useCloneRetryStore.getState().request(values);
      useUIStore.getState().setAddProjectOpen(true);
    },
    openReviewPane: () => useUIStore.getState().setReviewPaneOpen(true),
    openWorktrees: () => {
      const ui = useUIStore.getState();
      ui.setReviewSubTab('worktrees');
      ui.setReviewPaneOpen(true);
    },
  });
}

function loadBackgroundLists(): void {
  void loadWatchers();
  void loadJobs();
  void loadActivities();
}

/**
 * Loads the lists once on mount, so the per-thread clocks (ThreadWatcherIndicator)
 * and the footer counters are right without opening the panel (realtime events
 * keep them live afterwards; this button is always mounted, so this fills them
 * app-wide), and again on open. Returns a clock that ticks every second while open.
 */
function useBackgroundLists(open: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(loadBackgroundLists, []);
  useEffect(() => {
    if (!open) return;
    loadBackgroundLists();
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);
  return now;
}

function PanelTabs() {
  const { t } = useTranslation();
  const tabs: Array<[ActivityPanelTab, string]> = [
    ['activity', t('activity.tabActivity')],
    ['jobs', t('activity.tabJobs')],
    ['watchers', t('activity.tabWatchers')],
  ];
  return (
    <div className="border-border border-b px-2 py-2">
      <TabsList className="w-full">
        {tabs.map(([value, label]) => (
          <TabsTrigger
            key={value}
            value={value}
            className="flex-1"
            data-testid={`activity-panel-tab-${value}`}
          >
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
    </div>
  );
}

function FailedBadge({ count, alone }: { count: number; alone: boolean }) {
  if (count === 0) return null;
  return (
    <Badge
      variant="destructive"
      size="xs"
      className={cn('shrink-0', alone && 'ml-auto')}
      data-testid="sidebar-activity-failed-count"
    >
      {count}
    </Badge>
  );
}

/** The Activity tab: the user's activities, with retry, dismiss and clear. */
function ActivityTab({ now, onClose }: { now: number; onClose: () => void }) {
  const navigate = useNavigate();
  const activities = useActivities();
  const progress = useActivityProgress();
  const runnerOffline = useRunnerStatusStore((s) => s.status === 'offline');
  const retry = (activity: Activity) => {
    if (openRetryTarget(activity, navigate)) onClose();
  };
  return (
    <ScrollArea className={cn('max-h-96', activities.length > 6 && 'h-96')}>
      <ActivityList
        activities={activities}
        progress={progress}
        runnerOffline={runnerOffline}
        now={now}
        canRetry={canRetryActivity}
        onRetry={retry}
        onDismiss={(activity) => void dismissActivity(activity.id)}
        onClearFinished={() => void clearFinishedActivities()}
      />
    </ScrollArea>
  );
}

/**
 * The sidebar footer's background panel (track-background-activities): the
 * Activity tab lists the operations the user started (clone, worktree setup,
 * git workflow) from the server's activity rows; the Jobs and Watchers tabs
 * list the agents' `funny_spawn` processes and `funny_watch` snoozes as
 * before. The button counts what is running and what failed.
 */
export function ActivityPanelButton() {
  const { t } = useTranslation();
  const open = useActivityPanelStore((s) => s.open);
  const setOpen = useActivityPanelStore((s) => s.setOpen);
  const tab = useActivityPanelStore((s) => s.tab);
  const setTab = useActivityPanelStore((s) => s.setTab);
  const [showAll, setShowAll] = useState<'job' | 'watcher' | null>(null);
  const now = useBackgroundLists(open || showAll !== null);
  const { scopeId } = useTerminalScope();
  const watchersById = useWatchersById();
  const jobsById = useJobsById();
  const counts = useActivityCounts();

  const entries = useMemo(
    () => buildActivityEntries(jobsById, watchersById),
    [jobsById, watchersById],
  );
  const runningCount = counts.running + entries.filter((entry) => entry.active).length;
  const dialogEntries = showAll ? entries.filter((entry) => entry.kind === showAll) : [];
  const viewAll = (kind: 'job' | 'watcher') => {
    setOpen(false);
    setShowAll(kind);
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <NavItem
            icon={ActivityIcon}
            label={t('activity.title')}
            count={runningCount}
            isActive={open || showAll !== null}
            data-testid="sidebar-activity"
            trailing={<FailedBadge count={counts.failed} alone={runningCount === 0} />}
          />
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-96 p-1" data-testid="activity-panel">
          <Tabs value={tab} onValueChange={(value) => setTab(value as ActivityPanelTab)}>
            <PanelTabs />
            <TabsContent value="activity" className="mt-1">
              <ActivityTab now={now} onClose={() => setOpen(false)} />
            </TabsContent>
            <TabsContent value="jobs" className="mt-1" data-testid="watcher-panel">
              <BackgroundEntriesTab
                kind="job"
                entries={entries}
                scopeId={scopeId}
                now={now}
                onOpened={() => setOpen(false)}
                onViewAll={() => viewAll('job')}
              />
            </TabsContent>
            <TabsContent value="watchers" className="mt-1" data-testid="watchers-tab">
              <BackgroundEntriesTab
                kind="watcher"
                entries={entries}
                scopeId={scopeId}
                now={now}
                onOpened={() => setOpen(false)}
                onViewAll={() => viewAll('watcher')}
              />
            </TabsContent>
          </Tabs>
        </PopoverContent>
      </Popover>
      <WatchersDialog
        open={showAll !== null}
        onOpenChange={(next) => {
          if (!next) setShowAll(null);
        }}
        entries={dialogEntries}
        activeCount={dialogEntries.filter((entry) => entry.active).length}
        scopeId={scopeId}
        now={now}
      />
    </>
  );
}
