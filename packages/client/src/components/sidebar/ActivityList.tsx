import type { Activity } from '@funny/shared';
import { CircleAlert, CircleCheck, CircleSlash, Loader2, RotateCcw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { timeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';

/**
 * The Activity tab of the sidebar footer panel (track-background-activities):
 * the user's clones, worktree setups and git workflows. Rows come ordered
 * (running first, then finished newest first) from `useActivities`.
 */

export interface ActivityListProps {
  activities: Activity[];
  progress: Record<string, number>;
  /** The user's runner is not connected: running rows may never report again. */
  runnerOffline: boolean;
  now: number;
  canRetry: (activity: Activity) => boolean;
  onRetry: (activity: Activity) => void;
  onDismiss: (activity: Activity) => void;
  onClearFinished: () => void;
}

function StatusIcon({ status }: { status: Activity['status'] }) {
  switch (status) {
    case 'running':
      return <Loader2 className="icon-sm text-muted-foreground animate-spin" aria-hidden />;
    case 'succeeded':
      return <CircleCheck className="icon-sm text-status-success" aria-hidden />;
    case 'failed':
      return <CircleAlert className="icon-sm text-destructive" aria-hidden />;
    default:
      return <CircleSlash className="icon-sm text-status-pending" aria-hidden />;
  }
}

/** The second line of a row: the error, why it stopped, or the current step. */
function activityDetail(
  activity: Activity,
  percent: number | undefined,
  offline: boolean,
  t: (key: string) => string,
): string | null {
  if (activity.status === 'failed') return activity.error;
  if (activity.status === 'interrupted') return t('activity.interrupted');
  if (offline) return t('activity.runnerOffline');
  if (activity.status !== 'running') return null;
  const parts = [activity.step, percent !== undefined ? `${percent}%` : null].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function RowAction({
  label,
  testId,
  icon: Icon,
  onClick,
}: {
  label: string;
  testId: string;
  icon: typeof X;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground size-6"
          aria-label={label}
          data-testid={testId}
          onClick={onClick}
        >
          <Icon className="icon-sm" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function ActivityRow({
  activity,
  percent,
  runnerOffline,
  now,
  canRetry,
  onRetry,
  onDismiss,
}: {
  activity: Activity;
  percent: number | undefined;
  runnerOffline: boolean;
  now: number;
  canRetry: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const running = activity.status === 'running';
  const offline = running && runnerOffline;
  // A running row is dismissable only when its runner is gone.
  const dismissable = !running || offline;
  const detail = activityDetail(activity, percent, offline, t);
  const when = timeAgo(activity.endedAt ?? activity.startedAt, t, now);

  return (
    <div
      className="hover:bg-accent group flex items-start gap-2 rounded-md px-2 py-1.5"
      data-testid={`activity-item-${activity.id}`}
      data-status={activity.status}
    >
      <span className="mt-0.5 shrink-0">
        <StatusIcon status={activity.status} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{activity.title}</span>
          <span className="text-muted-foreground ml-auto shrink-0 text-xs">{when}</span>
        </div>
        {detail ? (
          <p
            className={cn(
              'truncate text-xs',
              activity.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
            )}
            title={detail}
            data-testid={`activity-item-detail-${activity.id}`}
          >
            {detail}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {canRetry ? (
          <RowAction
            label={t('activity.retry')}
            testId={`activity-item-retry-${activity.id}`}
            icon={RotateCcw}
            onClick={onRetry}
          />
        ) : null}
        {dismissable ? (
          <RowAction
            label={t('activity.dismiss')}
            testId={`activity-item-dismiss-${activity.id}`}
            icon={X}
            onClick={onDismiss}
          />
        ) : null}
      </div>
    </div>
  );
}

export function ActivityList({
  activities,
  progress,
  runnerOffline,
  now,
  canRetry,
  onRetry,
  onDismiss,
  onClearFinished,
}: ActivityListProps) {
  const { t } = useTranslation();
  const hasFinished = activities.some((a) => a.status !== 'running');

  if (activities.length === 0) {
    return (
      <EmptyState
        fill={false}
        className="px-2 py-4"
        title={t('activity.empty')}
        testId="activity-panel-empty"
      />
    );
  }

  return (
    <div className="flex flex-col gap-0.5" data-testid="activity-panel-list">
      {activities.map((activity) => (
        <ActivityRow
          key={activity.id}
          activity={activity}
          percent={progress[activity.id]}
          runnerOffline={runnerOffline}
          now={now}
          canRetry={canRetry(activity)}
          onRetry={() => onRetry(activity)}
          onDismiss={() => onDismiss(activity)}
        />
      ))}
      {hasFinished ? (
        <Button
          variant="ghost"
          className="mt-1 w-full border-t"
          data-testid="activity-panel-clear-finished"
          onClick={onClearFinished}
        >
          {t('activity.clearFinished')}
        </Button>
      ) : null}
    </div>
  );
}
