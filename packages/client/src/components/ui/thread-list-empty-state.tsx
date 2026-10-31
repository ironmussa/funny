import { cn } from '@/lib/utils';

import { EmptyState } from './empty-state';
export function ThreadListEmptyState({
  className,
  search,
  searchEmptyMessage,
  emptyMessage,
}: {
  className?: string;
  search?: string;
  searchEmptyMessage: string;
  emptyMessage: string;
}) {
  return (
    <EmptyState
      fill={false}
      className={cn('h-32', className)}
      title={search ? searchEmptyMessage : emptyMessage}
    />
  );
}
