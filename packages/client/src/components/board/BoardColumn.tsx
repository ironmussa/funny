/**
 * One column of a board: a header (title, count, optional extra controls) over
 * a scrolling list of cards, or an empty message. Shared by the thread kanban
 * and the factory board (openspec factory-pipeline-board, D2); what a card is,
 * and whether cards can be dropped on the column, is the caller's.
 */
import type { ReactNode, Ref } from 'react';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/utils';

export interface BoardColumnProps {
  /** `data-testid` of the column. */
  testId: string;
  title: ReactNode;
  count: number;
  /** Shown after the count (a limit, an add button). */
  headerExtra?: ReactNode;
  columnRef?: Ref<HTMLDivElement>;
  scrollRef?: Ref<HTMLDivElement>;
  /** Something is dragged over the column. */
  highlighted?: boolean;
  /** Only the header shows. */
  collapsed?: boolean;
  /** Replaces the default empty message. */
  emptyTitle?: string;
  className?: string;
  children: ReactNode;
}

export function BoardColumn({
  testId,
  title,
  count,
  headerExtra,
  columnRef,
  scrollRef,
  highlighted = false,
  collapsed = false,
  emptyTitle,
  className,
  children,
}: BoardColumnProps) {
  const { t } = useTranslation();
  return (
    <div
      ref={columnRef}
      data-testid={testId}
      className={cn(
        'flex flex-col w-92 min-w-92 shrink-0 rounded-lg bg-secondary/30 transition-colors',
        highlighted && 'ring-2 ring-ring bg-secondary/50',
        className,
      )}
    >
      <div className="border-border/50 flex items-center gap-2 border-b px-3 py-2.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-muted-foreground text-xs">({count})</span>
        {headerExtra}
      </div>
      {!collapsed && (
        <div ref={scrollRef} className="min-h-[200px] flex-1 space-y-2 overflow-y-auto p-2">
          {count === 0 ? (
            <EmptyState
              fill={false}
              padding="roomy"
              title={emptyTitle ?? t('kanban.emptyColumn')}
            />
          ) : (
            children
          )}
        </div>
      )}
    </div>
  );
}
