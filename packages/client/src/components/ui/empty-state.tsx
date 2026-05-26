import { type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface EmptyStateProps {
  /** Lucide icon component shown above the title. */
  icon?: LucideIcon;
  /** Primary line (e.g. "No stashed changes"). */
  title: ReactNode;
  /** Optional secondary line (smaller, lower-contrast). */
  description?: ReactNode;
  /** Optional action area rendered below the description (e.g. a button). */
  action?: ReactNode;
  /** Extra classes for the outer container — use sparingly. */
  className?: string;
  /** Hook for Playwright / unit tests. */
  testId?: string;
}

/**
 * Centered, dead-vertical empty-state block. Always fills its parent and
 * centers content both axes so callers don't have to remember the flex / size
 * boilerplate. Drop-in for the "nothing here" placeholders inside tab panels.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  testId,
}: EmptyStateProps) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center text-muted-foreground',
        className,
      )}
    >
      {Icon && <Icon className="size-8 opacity-40" />}
      <p className="text-xs">{title}</p>
      {description && <div className="text-[10px] text-muted-foreground/70">{description}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
