import { dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { Plus } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

interface Props {
  insertIndex: number;
  isDragging: boolean;
  disabled?: boolean;
}

/**
 * Vertical drop strip rendered between/around grid columns. Dropping a
 * thread here inserts a new grid column at that position and shifts existing
 * columns to the right.
 */
export const GridColumnInsertDropTarget = memo(function GridColumnInsertDropTarget({
  insertIndex,
  isDragging,
  disabled,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [isOver, setIsOver] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return dropTargetForElements({
      element: el,
      getData: () => ({ type: 'grid-col-insert', insertIndex }),
      canDrop: ({ source }) => !disabled && source.data.type === 'grid-thread',
      onDragEnter: () => setIsOver(true),
      onDragLeave: () => setIsOver(false),
      onDrop: () => setIsOver(false),
    });
  }, [insertIndex, disabled]);

  const active = isDragging && !disabled;
  return (
    <div
      ref={ref}
      className={cn(
        'shrink-0 self-stretch rounded-sm transition-all duration-150 overflow-hidden',
        isOver
          ? 'w-10 bg-primary/60 ring-2 ring-primary'
          : active
            ? 'w-6 bg-primary/10 hover:bg-primary/20'
            : 'w-1',
      )}
      data-testid={`grid-col-insert-${insertIndex}`}
    >
      {active && (
        <div className="flex h-full items-center justify-center">
          <Plus className="size-4 text-primary/60" />
        </div>
      )}
    </div>
  );
});
