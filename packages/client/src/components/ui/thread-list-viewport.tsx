import type { ReactNode, Ref } from 'react';

import { cn } from '@/lib/utils';

/**
 * The scrolling box of a thread list. `framed` (the default) draws it as a
 * bordered card; off, the rows sit straight on the page, as in the thread
 * search and the automation inbox.
 */
export function ThreadListViewport({
  className,
  scrollRef,
  testId,
  padded = false,
  framed = true,
  children,
}: {
  className?: string;
  scrollRef: Ref<HTMLDivElement>;
  testId: string;
  padded?: boolean;
  framed?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div
        ref={scrollRef}
        data-testid={testId}
        className={cn(
          'min-h-0 flex-1 overflow-y-auto',
          framed && 'border-border/50 rounded-lg border',
          padded && 'p-2',
        )}
      >
        {children}
      </div>
    </div>
  );
}
