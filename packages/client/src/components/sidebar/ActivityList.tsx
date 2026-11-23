import type { Activity } from '@funny/shared';
import { isDestructiveKind } from '@funny/shared/activities';
import {
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Loader2,
  RotateCcw,
  TriangleAlert,
  Undo2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { timeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';

/**
 * The Activity tab of the sidebar footer panel (track-background-activities):
 * the user's clones, worktree setups and git workflows, and what funny did on
 * its own (track-funny-actions): those carry an "Automatic" badge, a
 * destructive kind is marked, and a finished row lists its effects. Rows come ordered
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
  /** Whether the row offers Restore (an undo snapshot it can still put back). */
  canRestore?: (activity: Activity) => boolean;
  onRestore?: (activity: Activity) => void;
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

/**
 * The effects of a row, one line per distinct effect and target; repeats (two
 * terminals named zsh) are counted.
 */
function groupEffects(effects: NonNullable<Activity['effects']>) {
  const groups = new Map<string, { effect: string; target: string; count: number }>();
  for (const { effect, target } of effects) {
    const key = `${effect}:${target}`;
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { effect, target, count: 1 });
  }
  return [...groups.entries()];
}

/** What a finished activity removed, stopped or changed. */
function EffectsList({ activity }: { activity: Activity }) {
  const { t } = useTranslation();
  if (activity.status === 'running' || !activity.effects?.length) return null;
  return (
    <ul
      className="text-muted-foreground mt-0.5 flex flex-col text-xs"
      data-testid={`activity-item-effects-${activity.id}`}
    >
      {groupEffects(activity.effects).map(([key, { effect, target, count }]) => (
        <li
          key={key}
          className="truncate"
          title={target}
          data-testid={`activity-item-effect-${activity.id}-${effect}`}
        >
          {t(`activity.effects.${effect}`)}: {target}
          {count > 1 ? ` ×${count}` : ''}
        </li>
      ))}
    </ul>
  );
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

/** Retry, restore and dismiss for one row. */
function RowActions({
  activityId,
  canRetry,
  onRetry,
  canRestore,
  onRestore,
  dismissable,
  onDismiss,
}: {
  activityId: string;
  canRetry: boolean;
  onRetry: () => void;
  canRestore: boolean;
  onRestore: () => void;
  dismissable: boolean;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {canRetry ? (
        <RowAction
          label={t('activity.retry')}
          testId={`activity-item-retry-${activityId}`}
          icon={RotateCcw}
          onClick={onRetry}
        />
      ) : null}
      {canRestore ? (
        <RowAction
          label={t('activity.restore')}
          testId={`activity-item-restore-${activityId}`}
          icon={Undo2}
          onClick={onRestore}
        />
      ) : null}
      {dismissable ? (
        <RowAction
          label={t('activity.dismiss')}
          testId={`activity-item-dismiss-${activityId}`}
          icon={X}
          onClick={onDismiss}
        />
      ) : null}
    </div>
  );
}

function ActivityRow({
  activity,
  percent,
  runnerOffline,
  now,
  canRetry,
  onRetry,
  canRestore,
  onRestore,
  onDismiss,
}: {
  activity: Activity;
  percent: number | undefined;
  runnerOffline: boolean;
  now: number;
  canRetry: boolean;
  onRetry: () => void;
  canRestore: boolean;
  onRestore: () => void;
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
          {isDestructiveKind(activity.kind) ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <TriangleAlert
                  className="icon-sm text-status-pending shrink-0"
                  aria-label={t('activity.destructive')}
                  data-testid={`activity-item-destructive-${activity.id}`}
                />
              </TooltipTrigger>
              <TooltipContent>{t('activity.destructive')}</TooltipContent>
            </Tooltip>
          ) : null}
          <span className="truncate text-sm font-medium">{activity.title}</span>
          {activity.origin !== 'user' ? (
            <Badge
              variant="outline"
              className="shrink-0 px-1 py-0 text-xs font-normal"
              data-testid={`activity-item-automatic-${activity.id}`}
            >
              {t('activity.automatic')}
            </Badge>
          ) : null}
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
        <EffectsList activity={activity} />
      </div>
      <RowActions
        activityId={activity.id}
        canRetry={canRetry}
        onRetry={onRetry}
        canRestore={canRestore}
        onRestore={onRestore}
        dismissable={dismissable}
        onDismiss={onDismiss}
      />
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
  canRestore = () => false,
  onRestore = () => {},
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
          canRestore={canRestore(activity)}
          onRestore={() => onRestore(activity)}
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
