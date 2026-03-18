import { useTranslation } from 'react-i18next';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface DiffStatsProps {
  linesAdded: number;
  linesDeleted: number;
  dirtyFileCount?: number;
  /** "sm" for sidebar/kanban, "xs" for compact, "xxs" for kanban cards */
  size?: 'sm' | 'xs' | 'xxs';
  /** Show tooltips on hover (default: true for sm, false for xs) */
  tooltips?: boolean;
  className?: string;
}

/**
 * Compact git diff stats chip: +N -N · X
 * Used in sidebar thread items, kanban cards, and project header.
 */
export function DiffStats({
  linesAdded,
  linesDeleted,
  dirtyFileCount,
  size = 'sm',
  tooltips,
  className,
}: DiffStatsProps) {
  const { t } = useTranslation();
  const showTooltips = tooltips ?? size === 'sm';

  const hasDirty = dirtyFileCount != null && dirtyFileCount > 0;

  if (linesAdded === 0 && linesDeleted === 0 && !hasDirty) return null;

  const textSize = size === 'xxs' ? 'text-[10px]' : size === 'xs' ? 'text-xs' : 'text-sm';

  const added = (
    <Stat
      value={`+${linesAdded}`}
      colorClass="text-diff-added"
      tooltip={showTooltips ? t('gitStats.linesAdded', { count: linesAdded }) : undefined}
    />
  );

  const deleted = (
    <Stat
      value={`-${linesDeleted}`}
      colorClass="text-diff-removed"
      tooltip={showTooltips ? t('gitStats.linesDeleted', { count: linesDeleted }) : undefined}
    />
  );

  return (
    <span className={cn('flex flex-shrink-0 items-center gap-1 font-mono', textSize, className)}>
      {added}
      {deleted}
      {hasDirty && (
        <Stat
          value={`· ${dirtyFileCount}`}
          colorClass="text-muted-foreground"
          tooltip={showTooltips ? t('gitStats.dirtyFiles', { count: dirtyFileCount }) : undefined}
        />
      )}
    </span>
  );
}

function Stat({
  value,
  colorClass,
  tooltip,
}: {
  value: string;
  colorClass: string;
  tooltip?: string;
}) {
  const content = <span className={colorClass}>{value}</span>;
  if (!tooltip) return content;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}
