import { GitBranch } from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn, ICON_SIZE } from '@/lib/utils';

interface BranchBadgeProps {
  branch: string;
  size?: 'xs' | 'sm' | 'md';
  /**
   * `badge` (default): muted chip, for a branch inside a row's metadata or a sentence.
   * `plain`: no chip, inherits the surrounding color, for headers, toggles and row titles.
   */
  variant?: 'badge' | 'plain';
  className?: string;
  'data-testid'?: string;
}

const sizeStyles = {
  xs: { icon: ICON_SIZE['2xs'], text: 'text-[10px] leading-tight', chip: 'px-1 py-px' },
  sm: { icon: ICON_SIZE.xs, text: 'text-xs', chip: 'px-1 py-px' },
  md: { icon: ICON_SIZE.sm, text: 'text-sm', chip: 'px-1.5 py-0.5' },
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

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex min-w-0 items-center gap-1 font-mono',
            s.text,
            variant === 'badge' && ['bg-muted text-muted-foreground rounded font-medium', s.chip],
            className,
          )}
          data-testid={testId}
        >
          <GitBranch className={cn(s.icon, 'shrink-0')} aria-hidden="true" />
          <span className="truncate">{branch}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[min(28rem,calc(100vw-2rem))] font-mono break-all">
        {branch}
      </TooltipContent>
    </Tooltip>
  );
}
