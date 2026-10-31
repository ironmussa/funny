import { type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { STATE_ICON_CLASS, STATE_TEXT_CLASS } from '@/components/ui/state-styles';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  /** Lucide icon component shown above the title. */
  icon?: LucideIcon;
  /** Primary line (e.g. "No stashed changes"). */
  title: ReactNode;
  /** Optional secondary line (same size, lower contrast). */
  description?: ReactNode;
  /** Optional action area rendered below the description (e.g. a button). */
  action?: ReactNode;
  /** Extra classes for the outer container — use sparingly. */
  className?: string;
  /** Hook for Playwright / unit tests. */
  testId?: string;
  /** Fill a panel, or size to content inside lists and settings. */
  fill?: boolean;
}

/**
 * Centered empty-state block. By default fills its parent and centers content
 * on both axes; use fill={false} for content-sized list and settings placeholders.
 * Pair with {@link LoadingState} for the loading case in the same panel.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  testId,
  fill = true,
}: EmptyStateProps) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'flex w-full flex-col items-center justify-center gap-2 p-4 text-center text-muted-foreground',
        fill && 'h-full min-h-0 flex-1',
        className,
      )}
    >
      {Icon && <Icon className={cn(STATE_ICON_CLASS, 'opacity-40')} />}
      <p className={STATE_TEXT_CLASS}>{title}</p>
      {description && (
        <div className={cn(STATE_TEXT_CLASS, 'text-muted-foreground/70')}>{description}</div>
      )}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
