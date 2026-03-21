import { useCallback, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

type Direction = 'horizontal' | 'vertical';

interface UseResizeHandleOptions {
  /** 'horizontal' = col-resize (left/right), 'vertical' = row-resize (up/down) */
  direction: Direction;
  /** Called continuously during drag with the pointer position delta in px */
  onResize: (deltaPx: number) => void;
  /** Called when dragging starts */
  onResizeStart?: () => void;
  /** Called when dragging ends */
  onResizeEnd?: () => void;
}

export function useResizeHandle({
  direction,
  onResize,
  onResizeStart,
  onResizeEnd,
}: UseResizeHandleOptions) {
  const dragging = useRef(false);
  const startPos = useRef(0);
  const [resizing, setResizing] = useState(false);
  const cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      dragging.current = true;
      startPos.current = direction === 'horizontal' ? e.clientX : e.clientY;
      setResizing(true);
      document.body.style.cursor = cursor;
      document.body.style.userSelect = 'none';
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      onResizeStart?.();
    },
    [direction, cursor, onResizeStart],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      const current = direction === 'horizontal' ? e.clientX : e.clientY;
      onResize(current - startPos.current);
    },
    [direction, onResize],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      dragging.current = false;
      setResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      onResizeEnd?.();
    },
    [onResizeEnd],
  );

  return { resizing, handlePointerDown, handlePointerMove, handlePointerUp };
}

interface ResizeHandleProps {
  direction: Direction;
  resizing?: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  className?: string;
  'data-testid'?: string;
}

export function ResizeHandle({
  direction,
  resizing,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  className,
  'data-testid': testId,
}: ResizeHandleProps) {
  const isHorizontal = direction === 'horizontal';

  return (
    <button
      aria-label="Resize"
      tabIndex={-1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className={cn(
        'relative z-10 flex-shrink-0',
        isHorizontal
          ? 'w-px cursor-col-resize bg-border hover:bg-sidebar-accent'
          : 'h-1.5 cursor-row-resize after:absolute after:inset-x-0 after:top-1/2 after:h-px after:-translate-y-1/2 after:bg-border after:transition-colors hover:after:bg-sidebar-border',
        !isHorizontal && resizing && 'after:bg-sidebar-border',
        !resizing && 'transition-colors',
        className,
      )}
      data-testid={testId}
    />
  );
}
