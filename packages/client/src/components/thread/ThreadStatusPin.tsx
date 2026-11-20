import type { Thread } from '@funny/shared';
import { Clock, Loader2, Pin, PinOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ThreadWatcherIndicator } from '@/components/thread/ThreadWatcherIndicator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  threadActivityTooltip,
  useThreadActivity,
  type ThreadActivityView,
} from '@/hooks/use-thread-activity';
import { getDisplayThreadStatus, statusConfig, type DisplayThreadStatus } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';
import { useRunnerStatusStore } from '@/stores/runner-status-store';
import { isThreadUnread, useThreadReadStore } from '@/stores/thread-read-store';

export type ThreadStatusPinHoverGroup = 'thread' | 'card' | 'row';

// Static Tailwind class maps — listed literally so Tailwind's scanner picks
// them up. Parent element must declare the matching `group/<name>` class.
const HIDE_ON_HOVER: Record<ThreadStatusPinHoverGroup, string> = {
  thread: 'group-hover/thread:hidden',
  card: 'group-hover/card:hidden',
  row: 'group-hover/row:hidden',
};

const SHOW_ON_HOVER: Record<ThreadStatusPinHoverGroup, string> = {
  thread: 'group-hover/thread:flex',
  card: 'group-hover/card:flex',
  row: 'group-hover/row:flex',
};

export interface ThreadStatusPinProps {
  thread: Thread;
  onPin?: (pinned: boolean) => void;
  hoverGroup: ThreadStatusPinHoverGroup;
  showStatusTooltip?: boolean;
  className?: string;
}

const BUSY_DISPLAY_STATUSES: ReadonlySet<DisplayThreadStatus> = new Set([
  'running',
  'setting_up',
  'pending',
]);

/**
 * Whether the pin shows the "busy" affordances (no pin, no unread dot). Not once
 * the runner drops: the thread is effectively paused, and the user should be
 * able to pin or notice unread messages meanwhile. A factory run working
 * outside the agent (CI, merge) keeps the thread busy too.
 */
function isPinBusy(displayStatus: DisplayThreadStatus, activity: ThreadActivityView): boolean {
  return BUSY_DISPLAY_STATUSES.has(displayStatus) || activity.activity === 'factory';
}

export function ThreadStatusPin({
  thread,
  onPin,
  hoverGroup,
  showStatusTooltip = false,
  className,
}: ThreadStatusPinProps) {
  const { t } = useTranslation();
  const runnerStatus = useRunnerStatusStore((s) => s.status);
  const displayStatus = getDisplayThreadStatus(thread.status, runnerStatus);
  const activity = useThreadActivity(thread);
  const isBusy = isPinBusy(displayStatus, activity);
  const canPin = !!onPin;
  const showPinRest = canPin && thread.pinned && !isBusy;
  const hideOnHover = canPin ? HIDE_ON_HOVER[hoverGroup] : '';
  const showOnHover = SHOW_ON_HOVER[hoverGroup];
  const isUnread = useThreadReadStore((s) =>
    isThreadUnread(s.readAt, thread.id, thread.completedAt),
  );
  const showUnreadDot = isUnread && !isBusy && !showPinRest;

  const statusIcon =
    activity.activity === 'none' ? (
      <ThreadStatusIcon
        threadId={thread.id}
        displayStatus={displayStatus}
        withTooltip={showStatusTooltip}
      />
    ) : (
      <ThreadActivityIcon threadId={thread.id} view={activity} withTooltip={showStatusTooltip} />
    );

  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <span className={cn('relative size-3.5 shrink-0', className)}>
        {showPinRest ? (
          <button
            type="button"
            aria-label={t('thread.unpin', 'Unpin thread')}
            className={cn(
              'absolute inset-0 flex items-center justify-center p-0 text-muted-foreground',
              hideOnHover,
            )}
            onClick={(event) => {
              event.stopPropagation();
              onPin(false);
            }}
          >
            <Pin className="icon-sm" />
          </button>
        ) : showUnreadDot ? (
          <span
            className={cn('absolute inset-0 flex items-center justify-center', hideOnHover)}
            data-testid={`thread-unread-dot-${thread.id}`}
          >
            <span className="bg-status-info block size-2 rounded-full" />
          </span>
        ) : (
          <span className={cn('absolute inset-0 flex items-center justify-center', hideOnHover)}>
            {statusIcon}
          </span>
        )}
        {canPin && (
          <button
            type="button"
            aria-label={
              thread.pinned ? t('thread.unpin', 'Unpin thread') : t('thread.pin', 'Pin thread')
            }
            className={cn(
              'absolute inset-0 hidden cursor-pointer items-center justify-center p-0 text-muted-foreground hover:text-foreground',
              showOnHover,
            )}
            onClick={(e) => {
              e.stopPropagation();
              onPin!(!thread.pinned);
            }}
            data-testid={`thread-pin-toggle-${thread.id}`}
          >
            {thread.pinned ? <PinOff className="icon-sm" /> : <Pin className="icon-sm" />}
          </button>
        )}
      </span>
      <ThreadWatcherIndicator threadId={thread.id} />
    </span>
  );
}

/**
 * The status icon for a thread. A stopped thread renders as a red dot (same
 * shape as the unread dot) instead of the stop icon.
 */
function ThreadStatusIcon({
  threadId,
  displayStatus,
  withTooltip,
}: {
  threadId: string;
  displayStatus: ReturnType<typeof getDisplayThreadStatus>;
  withTooltip: boolean;
}) {
  const { t } = useTranslation();
  const cfg = statusConfig[displayStatus] ?? statusConfig.pending;
  const StatusIcon = cfg.icon;
  const glyph =
    displayStatus === 'stopped' ? (
      <span
        className="bg-status-error block size-2 rounded-full"
        data-testid={`thread-stopped-dot-${threadId}`}
      />
    ) : (
      <StatusIcon className={cn('icon-sm', cfg.className)} />
    );
  if (!withTooltip) return glyph;
  const label =
    displayStatus === 'runner_offline'
      ? t('thread.status.runnerOffline', { defaultValue: 'Runner offline' })
      : t(`thread.status.${displayStatus}`);
  return (
    <Tooltip>
      <TooltipTrigger asChild>{glyph}</TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * How a thread's factory activity reads: a spinner in the info tone while the
 * run works (apart from the agent's own), a clock while it waits for the
 * member, and the thread's own error icon once its pipeline stopped on an error.
 */
const ACTIVITY_GLYPH: Record<
  Exclude<ThreadActivityView['activity'], 'none'>,
  { icon: typeof Clock; className: string }
> = {
  factory: { icon: Loader2, className: 'text-status-info animate-spin' },
  'factory-attention': { icon: Clock, className: 'text-status-warning' },
  'factory-failed': statusConfig.failed,
};

/**
 * The status icon of a thread whose factory run is working outside the agent
 * (a spinner in the info tone, so it reads apart from the agent's own) or
 * waiting for the member.
 */
function ThreadActivityIcon({
  threadId,
  view,
  withTooltip,
}: {
  threadId: string;
  view: ThreadActivityView;
  withTooltip: boolean;
}) {
  const { t } = useTranslation();
  if (view.activity === 'none') return null;
  const activityCfg = ACTIVITY_GLYPH[view.activity];
  const ActivityIcon = activityCfg.icon;
  const glyph = (
    <ActivityIcon
      className={cn('icon-sm', activityCfg.className)}
      data-testid={`thread-factory-activity-${threadId}`}
      data-activity={view.activity}
    />
  );
  const label = threadActivityTooltip(t, view);
  if (!withTooltip || !label) return glyph;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{glyph}</TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
