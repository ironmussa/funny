import type { HTMLAttributes } from 'react';

import { contrastText, pastelize } from '@/components/ui/project-chip';
import { cn } from '@/lib/utils';

type LabelBadgeTone = 'info' | 'success';

const TONE_CLASSES: Record<LabelBadgeTone, string> = {
  info: 'bg-status-info/15 text-status-info',
  success: 'bg-status-success/15 text-status-success',
};

export type LabelBadgeProps = HTMLAttributes<HTMLSpanElement> &
  (
    | {
        /** Hex color (with or without `#`), e.g. a GitHub label color. Pastelized for the fill. */
        color: string;
        tone?: never;
      }
    | {
        /** A theme tone, for the app's own tags (worktree Main/Active). Follows light/dark. */
        tone: LabelBadgeTone;
        color?: never;
      }
  );

/**
 * Filled tag — the standard look for labels (worktree Main/Active, GitHub
 * issue labels, …). With `color` the fill is the pastelized color and the
 * text picks black or white for contrast; with `tone` both come from the theme.
 */
export function LabelBadge({ color, tone, className, style, ...props }: LabelBadgeProps) {
  const bg = color ? pastelize(color.startsWith('#') ? color : `#${color}`) : undefined;
  return (
    <span
      className={cn(
        'text-3xs inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0 leading-4 font-medium whitespace-nowrap',
        tone && TONE_CLASSES[tone],
        className,
      )}
      style={bg ? { backgroundColor: bg, color: contrastText(bg), ...style } : style}
      {...props}
    />
  );
}
