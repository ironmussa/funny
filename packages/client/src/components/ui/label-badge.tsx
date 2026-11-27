import type { HTMLAttributes } from 'react';

import { contrastText, pastelize } from '@/components/ui/project-chip';
import { cn } from '@/lib/utils';

export type LabelBadgeTone = 'info' | 'success' | 'warning' | 'danger' | 'neutral';

/** The app's own tags get a fixed pastel, like a GitHub label color would. */
const TONE_COLORS: Record<LabelBadgeTone, string> = {
  info: '#7CB9E8',
  success: '#A8D5A2',
  warning: '#F9D98C',
  danger: '#F4A4A4',
  neutral: '#C8C8C8',
};

/**
 * The size of every chip in the review pane: the same as the branch chips in
 * the History tab (`text-2xs`, 16px tall, fully rounded).
 */
const chipSizeClassName =
  'text-2xs inline-flex h-4 shrink-0 items-center gap-0.5 rounded-full px-2 leading-none font-medium whitespace-nowrap';

export type LabelBadgeProps = HTMLAttributes<HTMLSpanElement> & {
  /**
   * The chip acts as a button (the caller gives it `onClick`/`role`): it shows
   * a pointer and a focus/hover ring. Used for the issue labels you click to
   * filter by.
   */
  interactive?: boolean;
  /** An interactive chip that is currently on (its filter is applied): a steady ring. */
  active?: boolean;
} & (
    | {
        /** Hex color (with or without `#`), e.g. a GitHub label color. Pastelized for the fill. */
        color: string;
        tone?: never;
      }
    | {
        /** A pastel for the app's own tags (worktree Main/Active, factory states). */
        tone: LabelBadgeTone;
        color?: never;
      }
  );

/**
 * Filled tag — the standard look for labels (worktree Main/Active, GitHub
 * issue labels, …). The fill is the pastelized color (or the tone's pastel)
 * and the text picks black or white for contrast.
 */
export function LabelBadge({
  color,
  tone,
  interactive,
  active,
  className,
  style,
  ...props
}: LabelBadgeProps) {
  const hex = color
    ? color.startsWith('#')
      ? color
      : `#${color}`
    : TONE_COLORS[tone ?? 'neutral'];
  const bg = pastelize(hex);
  return (
    <span
      className={cn(
        chipSizeClassName,
        interactive && 'hover:ring-ring/60 cursor-pointer transition-shadow hover:ring-1',
        active && 'ring-ring ring-1',
        className,
      )}
      style={{ backgroundColor: bg, color: contrastText(bg), ...style }}
      {...props}
    />
  );
}
