import { useTranslation } from 'react-i18next';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface DiffStatsProps {
  linesAdded: number;
  linesDeleted: number;
  dirtyFileCount?: number;
  /** "sm" for sidebar/kanban, "xs" for kanban cards */
  size?: 'sm' | 'xs';
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

  const hasLines = linesAdded > 0 || linesDeleted > 0;
  const hasFiles = (dirtyFileCount ?? 0) > 0;

  if (!hasLines && !hasFiles) return null;

  const textSize = size === 'xs' ? 'text-[10px]' : 'text-xs';

  // Only file count, no line stats
  if (!hasLines && hasFiles) {
    const content = (
      <span className={cn('flex-shrink-0 font-mono text-muted-foreground', textSize, className)}>
        {dirtyFileCount} {dirtyFileCount === 1 ? 'file' : 'files'}
      </span>
    );
    if (!showTooltips) return content;
    return (
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {t('gitStats.dirtyFiles', { count: dirtyFileCount })}
        </TooltipContent>
      </Tooltip>
    );
  }

  const added = linesAdded > 0 && (
    <Stat
      value={`+${linesAdded}`}
      colorClass="text-diff-added"
      tooltip={showTooltips ? t('gitStats.linesAdded', { count: linesAdded }) : undefined}
    />
  );

  const deleted = linesDeleted > 0 && (
    <Stat
      value={`-${linesDeleted}`}
      colorClass="text-diff-removed"
      tooltip={showTooltips ? t('gitStats.linesDeleted', { count: linesDeleted }) : undefined}
    />
  );

  const files = hasFiles && (
    <Stat
      value={`· ${dirtyFileCount}`}
      colorClass="text-muted-foreground"
      tooltip={showTooltips ? t('gitStats.dirtyFiles', { count: dirtyFileCount }) : undefined}
    />
  );

  return (
    <span className={cn('flex flex-shrink-0 items-center gap-1 font-mono', textSize, className)}>
      {added}
      {deleted}
      {files}
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
