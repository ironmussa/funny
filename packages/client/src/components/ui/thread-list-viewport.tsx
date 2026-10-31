import type { ReactNode, Ref } from 'react';

import { cn } from '@/lib/utils';
export function ThreadListViewport({
  className,
  scrollRef,
  testId,
  padded = false,
  children,
}: {
  className?: string;
  scrollRef: Ref<HTMLDivElement>;
  testId: string;
  padded?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div
        ref={scrollRef}
        data-testid={testId}
        className={cn(
          'border-border/50 min-h-0 flex-1 overflow-y-auto rounded-lg border',
          padded && 'p-2',
        )}
      >
        {children}
      </div>
    </div>
  );
}
