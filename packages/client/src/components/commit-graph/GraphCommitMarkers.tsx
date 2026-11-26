import { useTranslation } from 'react-i18next';

import { GitStatChip } from '@/components/git/GitStatChip';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { GIT_UNPULLED_ICON, GIT_UNPUSHED_ICON } from '@/lib/git-icons';
import { gitSyncStateConfig, shortTimeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';

export function GraphCommitTime({ committedAt }: { committedAt: string }) {
  const now = useMinuteTick();

  return <span>{shortTimeAgo(committedAt, now)}</span>;
}

/**
 * A commit's sync state, drawn like a thread's git widget (`GitStatsChip`): the
 * same muted chip holding an arrow up for not pushed, down for not pulled, in
 * the sidebar's color. The newest commit of a run carries the run's size (the
 * count the sidebar shows); an older commit of the run counts itself, 1.
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
    <Badge
      variant="subtle"
      size="stat-group"
      weight="normal"
      corners="square"
      className={cn('shrink-0', className)}
    >
      {unpushed && (
        <GitStatChip
          testId={`graph-unpushed-${shortHash}`}
          className={syncClass}
          icon={GIT_UNPUSHED_ICON}
          count={unpushedCount ?? 1}
          tooltip={t('history.unpushed', 'Not pushed')}
        />
      )}
      {unpushed && unpulled && <Separator orientation="vertical" className="h-3" />}
      {unpulled && (
        <GitStatChip
          testId={`graph-unpulled-${shortHash}`}
          className={syncClass}
          icon={GIT_UNPULLED_ICON}
          count={unpulledCount ?? 1}
          tooltip={t('history.unpulled', 'Not pulled')}
        />
      )}
    </Badge>
  );
}
