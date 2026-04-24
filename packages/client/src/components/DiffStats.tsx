import { FileIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface DiffStatsProps {
  linesAdded: number;
  linesDeleted: number;
  dirtyFileCount?: number;
  /**
   * Variant distinguishes the source of the stats:
   * - "local" (default): workspace diff (uncommitted changes)
   * - "pr": remote PR diff from GitHub
   */
  variant?: 'local' | 'pr';
  /** "sm" for sidebar/kanban, "xs" for compact, "xxs" for kanban cards */
  size?: 'sm' | 'xs' | 'xxs';
  /** Show tooltips on hover (default: true for sm, false for xs) */
  tooltips?: boolean;
  className?: string;
  /** Optional content rendered inside the pill after the stats (e.g. sync arrows). */
  trailing?: React.ReactNode;
}

/**
 * Compact git diff stats chip: +N -N · X
 * Used in sidebar thread items, kanban cards, review pane, and PR summary.
 *
 * `variant="local"` — workspace diff stats (dirty files)
 * `variant="pr"` — PR diff stats from GitHub (changed files)
 */
export function DiffStats({
  linesAdded,
  linesDeleted,
  dirtyFileCount,
  variant = 'local',
  size = 'sm',
  tooltips,
  className,
  trailing,
}: DiffStatsProps) {
  const { t } = useTranslation();
  const showTooltips = tooltips ?? size === 'sm';

  const hasDirty = dirtyFileCount != null && dirtyFileCount > 0;

  if (linesAdded === 0 && linesDeleted === 0 && !hasDirty) return null;

  const textSize = size === 'xxs' ? 'text-[10px]' : size === 'xs' ? 'text-xs' : 'text-sm';
  const padding = size === 'xxs' ? 'px-1 py-0' : size === 'xs' ? 'px-1.5 py-0.5' : 'px-2 py-0.5';

  const addedTooltip =
    variant === 'pr'
      ? t('gitStats.prLinesAdded', {
          count: linesAdded,
          defaultValue: '{{count}} lines added in PR',
        })
      : t('gitStats.linesAdded', { count: linesAdded });

  const deletedTooltip =
    variant === 'pr'
      ? t('gitStats.prLinesDeleted', {
          count: linesDeleted,
          defaultValue: '{{count}} lines deleted in PR',
        })
      : t('gitStats.linesDeleted', { count: linesDeleted });

  const fileTooltip =
    variant === 'pr'
      ? t('gitStats.prChangedFiles', {
          count: dirtyFileCount,
          defaultValue: '{{count}} changed files in PR',
        })
      : t('gitStats.dirtyFiles', { count: dirtyFileCount });

  const added = (
    <Stat
      value={`+${linesAdded}`}
      colorClass="text-diff-added"
      tooltip={showTooltips ? addedTooltip : undefined}
    />
  );

  const deleted = (
    <Stat
      value={`-${linesDeleted}`}
      colorClass="text-diff-removed"
      tooltip={showTooltips ? deletedTooltip : undefined}
    />
  );

  const iconSize = size === 'xxs' ? 10 : size === 'xs' ? 12 : 14;

  return (
    <span
      className={cn(
        'inline-flex flex-shrink-0 items-center gap-1 rounded-lg border border-border font-mono',
        textSize,
        padding,
        className,
      )}
    >
      {hasDirty && (
        <>
          <FileIcon size={iconSize} className="shrink-0 text-muted-foreground" />
          <Stat
            value={dirtyFileCount}
            colorClass="text-muted-foreground"
            tooltip={showTooltips ? fileTooltip : undefined}
          />
        </>
      )}
      {hasDirty && (linesAdded > 0 || linesDeleted > 0) && (
        <span className="text-muted-foreground">·</span>
      )}
      {added}
      {deleted}
      {trailing}
    </span>
  );
}

function Stat({
  value,
  colorClass,
  tooltip,
}: {
  value: React.ReactNode;
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
