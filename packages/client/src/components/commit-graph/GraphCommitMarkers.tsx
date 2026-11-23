import { ArrowDownCircle, ArrowUpCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { shortTimeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';

export function GraphCommitTime({ committedAt }: { committedAt: string }) {
  const now = useMinuteTick();

  return <span>{shortTimeAgo(committedAt, now)}</span>;
}

export function GraphCommitSyncMarkers({
  unpushed,
  unpulled = false,
  shortHash,
  className,
}: {
  unpushed: boolean;
  unpulled?: boolean;
  shortHash: string;
  className?: string;
}) {
  const { t } = useTranslation();
  if (!unpushed && !unpulled) return null;

  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1', className)}>
      {unpushed && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              aria-label={t('history.unpushed', 'Not pushed')}
              className="inline-flex shrink-0"
              data-testid={`graph-unpushed-${shortHash}`}
            >
              <ArrowUpCircle
                className="icon-sm text-primary [&_path]:stroke-primary-foreground [&_circle]:fill-current"
                data-testid={`graph-unpushed-icon-${shortHash}`}
                strokeWidth={3}
              />
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">{t('history.unpushed', 'Not pushed')}</TooltipContent>
        </Tooltip>
      )}
      {unpulled && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              aria-label={t('history.unpulled', 'Not pulled')}
              className="inline-flex shrink-0"
              data-testid={`graph-unpulled-${shortHash}`}
            >
              <ArrowDownCircle
                className="icon-sm text-primary [&_path]:stroke-primary-foreground [&_circle]:fill-current"
                data-testid={`graph-unpulled-icon-${shortHash}`}
                strokeWidth={3}
              />
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">{t('history.unpulled', 'Not pulled')}</TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}
