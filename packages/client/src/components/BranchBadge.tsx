import { GitBranch } from 'lucide-react';

import { contrastText, darkenHex } from '@/components/ui/project-chip';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { branchColor } from '@/lib/graph-colors';
import { cn, ICON_SIZE } from '@/lib/utils';

interface BranchBadgeProps {
  branch: string;
  size?: 'xs' | 'sm' | 'md';
  /**
   * `badge` (default): pastel chip in the branch's History graph color (`branchColor`), for a
   * branch inside a row's metadata or a sentence.
   * `plain`: no chip, inherits the surrounding color, for headers, toggles and row titles.
   */
  variant?: 'badge' | 'plain';
  /**
   * Outline the chip in a darker shade of its own color, the way the History
   * graph marks the open thread's branch. `highlightLabel` is read by screen
   * readers and shown in the tooltip, since the outline alone says nothing.
   */
  highlighted?: boolean;
  highlightLabel?: string;
  className?: string;
  'data-testid'?: string;
}

const sizeStyles = {
  // `xs` is the History tab's chip size (15px tall, `text-2xs`).
  xs: { icon: ICON_SIZE['2xs'], text: 'text-2xs leading-none', chip: 'h-[0.9375rem] px-1.5' },
  sm: { icon: ICON_SIZE.xs, text: 'text-xs', chip: 'px-1.5 py-px' },
  md: { icon: ICON_SIZE.sm, text: 'text-sm', chip: 'px-2 py-0.5' },
};

const BRANCH_COLOR_CLASSES =
  'bg-[color:var(--branch-badge-bg)] text-[color:var(--branch-badge-fg)]';
const BRANCH_OUTLINE_CLASS = '[box-shadow:0_0_0_1.5px_var(--branch-badge-outline)]';

/** Classes that read the branch color variables set in the chip's style. */
function branchColorClasses(bg: string | undefined, outlined: boolean) {
  if (!bg) return undefined;
  return outlined ? [BRANCH_COLOR_CLASSES, BRANCH_OUTLINE_CLASS] : BRANCH_COLOR_CLASSES;
}

/**
 * The one way a git branch name is shown in the UI: branch icon, monospace
 * name truncated to the available width, full name in a tooltip.
 */
export function BranchBadge({
  branch,
  size = 'sm',
  variant = 'badge',
  highlighted = false,
  highlightLabel,
  className,
  'data-testid': testId = 'branch-badge',
}: BranchBadgeProps) {
  const s = sizeStyles[size];
  const bg = variant === 'badge' ? branchColor(branch) : undefined;
  const outlined = highlighted && !!bg;

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
            // Last, so the branch color wins over a caller's color classes
            // (it used to be an inline style).
            branchColorClasses(bg, outlined),
          )}
          style={
            bg
              ? {
                  '--branch-badge-bg': bg,
                  '--branch-badge-fg': contrastText(bg),
                  '--branch-badge-outline': outlined ? darkenHex(bg, 0.35) : undefined,
                }
              : undefined
          }
          data-testid={testId}
          data-highlighted={highlighted || undefined}
        >
          <GitBranch className={cn(s.icon, 'shrink-0')} aria-hidden="true" />
          <span className="truncate">{branch}</span>
          {highlighted && highlightLabel ? <span className="sr-only">{highlightLabel}</span> : null}
        </span>
      </TooltipTrigger>
      <TooltipContent variant="mono">
        {highlighted && highlightLabel ? `${branch} · ${highlightLabel}` : branch}
      </TooltipContent>
    </Tooltip>
  );
}
