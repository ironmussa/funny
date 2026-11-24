import { useTranslation } from 'react-i18next';

import { GitStatChip } from '@/components/git/GitStatChip';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { GIT_UNPULLED_ICON, GIT_UNPUSHED_ICON } from '@/lib/git-icons';
import { gitSyncStateConfig, shortTimeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';

export function GraphCommitTime({ committedAt }: { committedAt: string }) {
  const now = useMinuteTick();

  return <span>{shortTimeAgo(committedAt, now)}</span>;
}

/**
 * A commit's sync state, drawn like the sidebar's git chips (`GitStatChip`): an
 * arrow up for not pushed, down for not pulled, in the sidebar's color. The
 * newest commit of a run carries the run's size (the count the sidebar shows),
 * the older ones only the arrow.
 */
export function GraphCommitSyncMarkers({
  unpushed,
  unpulled = false,
  unpushedCount,
  unpulledCount,
  shortHash,
  className,
}: {
  unpushed: boolean;
  unpulled?: boolean;
  unpushedCount?: number;
  unpulledCount?: number;
  shortHash: string;
  className?: string;
}) {
  const { t } = useTranslation();
  if (!unpushed && !unpulled) return null;
  const syncClass = gitSyncStateConfig.unpushed.className;

  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5', className)}>
      {unpushed && (
        <GitStatChip
          testId={`graph-unpushed-${shortHash}`}
          className={syncClass}
          icon={GIT_UNPUSHED_ICON}
          count={unpushedCount}
          tooltip={t('history.unpushed', 'Not pushed')}
        />
      )}
      {unpulled && (
        <GitStatChip
          testId={`graph-unpulled-${shortHash}`}
          className={syncClass}
          icon={GIT_UNPULLED_ICON}
          count={unpulledCount}
          tooltip={t('history.unpulled', 'Not pulled')}
        />
      )}
    </span>
  );
}
