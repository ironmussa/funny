import { forwardRef, useCallback, useRef, useState } from 'react';

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
      Object.assign(document.body.style, { cursor, userSelect: 'none' });
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
      Object.assign(document.body.style, { cursor: '', userSelect: '' });
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      onResizeEnd?.();
    },
    [onResizeEnd],
  );

  return { resizing, handlePointerDown, handlePointerMove, handlePointerUp };
}

interface ResizeHandleProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onClick'
> {
  direction: Direction;
  resizing?: boolean;
  onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  className?: string;
  'data-testid'?: string;
}

export const ResizeHandle = forwardRef<HTMLButtonElement, ResizeHandleProps>(function ResizeHandle(
  {
    direction,
    resizing,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onClick,
    className,
    'data-testid': testId,
    ...rest
  },
  ref,
) {
  const isHorizontal = direction === 'horizontal';

  return (
    <button
      ref={ref}
      aria-label="Resize"
      tabIndex={-1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClick={onClick}
      className={cn(
        'relative z-10 flex-shrink-0',
        isHorizontal
          ? 'w-1.5 cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border after:transition-all after:ease-linear hover:after:w-[3px] hover:after:bg-ring/50'
          : 'h-1.5 cursor-row-resize after:absolute after:inset-x-0 after:top-1/2 after:h-px after:-translate-y-1/2 after:bg-border after:transition-all after:ease-linear hover:after:h-[3px] hover:after:bg-ring/50',
        isHorizontal && resizing && 'after:!w-[3px] after:!bg-ring/50',
        !isHorizontal && resizing && 'after:!h-[3px] after:!bg-ring/50',
        className,
      )}
      data-testid={testId}
      {...rest}
    />
  );
});
