import { GitBranch } from 'lucide-react';

import { colorFromName, contrastText, pastelize } from '@/components/ui/project-chip';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn, ICON_SIZE } from '@/lib/utils';

interface BranchBadgeProps {
  branch: string;
  size?: 'xs' | 'sm' | 'md';
  /**
   * `badge` (default): pastel chip (color picked from the branch name), for a
   * branch inside a row's metadata or a sentence.
   * `plain`: no chip, inherits the surrounding color, for headers, toggles and row titles.
   */
  variant?: 'badge' | 'plain';
  className?: string;
  'data-testid'?: string;
}

const sizeStyles = {
  // `xs` is the History tab's chip size (15px tall, `text-2xs`).
  xs: { icon: ICON_SIZE['2xs'], text: 'text-2xs leading-none', chip: 'h-[0.9375rem] px-1.5' },
  sm: { icon: ICON_SIZE.xs, text: 'text-xs', chip: 'px-1.5 py-px' },
  md: { icon: ICON_SIZE.sm, text: 'text-sm', chip: 'px-2 py-0.5' },
};

/**
 * The one way a git branch name is shown in the UI: branch icon, monospace
 * name truncated to the available width, full name in a tooltip.
 */
export function BranchBadge({
  branch,
  size = 'sm',
  variant = 'badge',
  className,
  'data-testid': testId = 'branch-badge',
}: BranchBadgeProps) {
  const s = sizeStyles[size];
  const bg = variant === 'badge' ? pastelize(colorFromName(branch)) : undefined;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex min-w-0 items-center gap-1 font-mono',
            s.text,
            // `will-change-transform` gives the chip its own layer, which the
            // browser places on a whole pixel. The 14px root makes most row
            // offsets fractional (leading-5 = 17.5px), and without the layer the
            // background and the text round differently: the name sits up to
            // 1px off-center depending on where the row lands.
            variant === 'badge' && ['rounded-full font-medium will-change-transform', s.chip],
            className,
          )}
          style={bg ? { backgroundColor: bg, color: contrastText(bg) } : undefined}
          data-testid={testId}
        >
          <GitBranch className={cn(s.icon, 'shrink-0')} aria-hidden="true" />
          <span className="truncate">{branch}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent variant="mono">{branch}</TooltipContent>
    </Tooltip>
  );
}
