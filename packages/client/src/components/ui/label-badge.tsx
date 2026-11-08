import type { HTMLAttributes } from 'react';

import { contrastText, pastelize } from '@/components/ui/project-chip';
import { cn } from '@/lib/utils';

export interface LabelBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** Hex color (with or without `#`), e.g. a GitHub label color. Pastelized for the fill. */
  color: string;
}

/**
 * Filled pastel tag — the standard look for labels (worktree Main/Active,
 * GitHub issue labels, …). The fill is the pastelized `color`; the text picks
 * black or white for contrast.
 */
export function LabelBadge({ color, className, style, ...props }: LabelBadgeProps) {
  const bg = pastelize(color.startsWith('#') ? color : `#${color}`);
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0 text-[9px] leading-4 font-medium whitespace-nowrap',
        className,
      )}
      style={{ backgroundColor: bg, color: contrastText(bg), ...style }}
      {...props}
    />
  );
}
