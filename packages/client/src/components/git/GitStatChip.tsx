import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * Layout of a git stat chip (icon + count, no border or fill; the color is the
 * state). Shared with `PRBadge variant="plain"` so the uncommitted-changes,
 * unpushed-commits and PR indicators line up at the same size.
 */
export const GIT_STAT_CHIP_CLASS = 'flex shrink-0 items-center gap-0.5 text-xs leading-none';
export const GIT_STAT_ICON_CLASS = 'icon-sm';

export function GitStatChip({
  testId,
  className,
  icon: Icon,
  count,
  tooltip,
}: {
  testId: string;
  className: string;
  icon: LucideIcon;
  count?: number;
  tooltip: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn(GIT_STAT_CHIP_CLASS, className)} data-testid={testId}>
          <Icon className={GIT_STAT_ICON_CLASS} aria-hidden="true" />
          {count ? <span className="font-mono">{count}</span> : null}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}
