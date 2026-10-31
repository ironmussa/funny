import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { STATE_ICON_CLASS, STATE_TEXT_CLASS } from '@/components/ui/state-styles';
import { cn } from '@/lib/utils';

type LoadingLayout = 'stack' | 'inline';

interface LoadingStateProps {
  /** Primary line shown next to or below the spinner. */
  label?: ReactNode;
  /** Extra classes for the outer container — use sparingly. */
  className?: string;
  /** Hook for Playwright / unit tests. */
  testId?: string;
  /** Stack (spinner above label) or inline (spinner beside label). */
  layout?: LoadingLayout;
  /** When false, sizes to content instead of filling the parent. */
  fill?: boolean;
}

/**
 * Centered loading block for pane-level placeholders. Fills its parent and
 * centers content on both axes so callers don't need flex boilerplate.
 *
 * Pair with {@link EmptyState} for the empty / error cases in the same panel.
 */
export function LoadingState({
  label,
  className,
  testId,
  layout = 'stack',
  fill = true,
}: LoadingStateProps) {
  const isInline = layout === 'inline';

  return (
    <div
      data-testid={testId}
      className={cn(
        'flex items-center justify-center',
        isInline ? 'flex-row text-left' : 'flex-col text-center',
        fill && 'h-full w-full min-h-0 flex-1 p-4',
        'gap-2',
        className,
      )}
    >
      <Loader2 className={cn(STATE_ICON_CLASS, 'animate-spin text-muted-foreground/70')} />
      {label != null && label !== '' && (
        <p className={cn(STATE_TEXT_CLASS, 'text-muted-foreground')}>{label}</p>
      )}
    </div>
  );
}
