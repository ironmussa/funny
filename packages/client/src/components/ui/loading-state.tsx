import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

type LoadingSize = 'default' | 'compact';
type LoadingLayout = 'stack' | 'inline';

const SIZE_STYLES: Record<LoadingSize, { spinner: string; label: string; gap: string }> = {
  /** Pane-level loading — main column, review sidebar, tab panels. */
  default: {
    spinner: 'icon-xl animate-spin text-muted-foreground/70',
    label: 'text-sm text-muted-foreground/60',
    gap: 'gap-3',
  },
  /** Dense areas — overlays, dialog fragments, inline blocks. */
  compact: {
    spinner: 'icon-sm animate-spin text-muted-foreground',
    label: 'text-xs text-muted-foreground',
    gap: 'gap-2',
  },
};

interface LoadingStateProps {
  /** Primary line shown next to or below the spinner. */
  label?: ReactNode;
  /** Extra classes for the outer container — use sparingly. */
  className?: string;
  /** Hook for Playwright / unit tests. */
  testId?: string;
  /** Visual scale. Default matches pane-level placeholders across columns. */
  size?: LoadingSize;
  /** Stack (spinner above label) or inline (spinner beside label). */
  layout?: LoadingLayout;
  /** When false, sizes to content instead of filling the parent. */
  fill?: boolean;
  /** Override spinner size / color — prefer {@link size} when possible. */
  spinnerClassName?: string;
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
  size = 'default',
  layout = 'stack',
  fill = true,
  spinnerClassName,
}: LoadingStateProps) {
  const styles = SIZE_STYLES[size];
  const isInline = layout === 'inline';

  return (
    <div
      data-testid={testId}
      className={cn(
        'flex items-center justify-center',
        isInline ? 'flex-row text-left' : 'flex-col text-center',
        fill && 'h-full w-full min-h-0 flex-1 p-4',
        styles.gap,
        className,
      )}
    >
      <Loader2 className={cn(styles.spinner, spinnerClassName)} />
      {label != null && label !== '' && (
        <p className={cn(styles.label, isInline && 'whitespace-nowrap')}>{label}</p>
      )}
    </div>
  );
}

/** Alias for {@link LoadingState}. */
export { LoadingState as Loading };
