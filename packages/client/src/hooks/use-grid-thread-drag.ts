import { draggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { useEffect, useRef, useState } from 'react';

import { setDashedDragPreview } from '@/lib/drag-preview';

/** Registers the row as a drag source so threads can be dropped into grid cells. */
export function useGridThreadDrag(threadId: string, projectId: string) {
  const dragRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const el = dragRef.current;
    if (!el) return;
    return draggable({
      element: el,
      getInitialData: () => ({ type: 'grid-thread', threadId, projectId }),
      onGenerateDragPreview: ({ nativeSetDragImage }) =>
        setDashedDragPreview({ nativeSetDragImage, source: el }),
      onDragStart: () => setIsDragging(true),
      onDrop: () => setIsDragging(false),
    });
  }, [threadId, projectId]);

  return { dragRef, isDragging };
}
