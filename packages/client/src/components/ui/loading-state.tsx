import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface LoadingStateProps {
  /** Primary line shown next to the spinner. */
  label?: ReactNode;
  /** Extra classes for the outer container — use sparingly. */
  className?: string;
  /** Hook for Playwright / unit tests. */
  testId?: string;
  /** Override spinner size / color. */
  spinnerClassName?: string;
}

/**
 * Centered loading block. Always fills its parent and centers content on both
 * axes so callers don't have to remember the flex / size boilerplate. Drop-in
 * for initial-load placeholders inside tab panels and full-pane views.
 *
 * Pair with {@link EmptyState} for the empty / error cases in the same panel.
 */
export function LoadingState({ label, className, testId, spinnerClassName }: LoadingStateProps) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'flex h-full w-full min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground',
        className,
      )}
    >
      <Loader2 className={cn('icon-sm animate-spin', spinnerClassName)} />
      {label != null && label !== '' && <p>{label}</p>}
    </div>
  );
}
