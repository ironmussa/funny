import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import * as React from 'react';

import { cn } from '@/lib/utils';

interface ScrollAreaProps extends React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> {
  edgeFade?: boolean;
}

interface EdgeFadeState {
  top: boolean;
  bottom: boolean;
}

function requestScrollFrame(callback: FrameRequestCallback): number {
  if (typeof window.requestAnimationFrame === 'function') {
    return window.requestAnimationFrame(callback);
  }
  return window.setTimeout(() => callback(Date.now()), 16);
}

function cancelScrollFrame(id: number) {
  if (typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(id);
    return;
  }
  window.clearTimeout(id);
}

const ScrollArea = React.forwardRef<
  React.ComponentRef<typeof ScrollAreaPrimitive.Root>,
  ScrollAreaProps
>(({ className, children, edgeFade = false, ...props }, ref) => {
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const frameRef = React.useRef<number | null>(null);
  const [edgeFadeState, setEdgeFadeState] = React.useState<EdgeFadeState>({
    top: false,
    bottom: false,
  });

  const updateEdgeFadeState = React.useCallback(() => {
    const node = viewportRef.current;
    if (!edgeFade || !node) {
      setEdgeFadeState((current) =>
        current.top || current.bottom ? { top: false, bottom: false } : current,
      );
      return;
    }

    const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
    const next = {
      top: node.scrollTop > 0,
      bottom: maxScrollTop - node.scrollTop > 1,
    };

    setEdgeFadeState((current) =>
      current.top === next.top && current.bottom === next.bottom ? current : next,
    );
  }, [edgeFade]);

  const scheduleEdgeFadeUpdate = React.useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestScrollFrame(() => {
      frameRef.current = null;
      updateEdgeFadeState();
    });
  }, [updateEdgeFadeState]);

  React.useLayoutEffect(() => {
    if (!edgeFade) {
      updateEdgeFadeState();
      return;
    }

    const node = viewportRef.current;
    if (!node) return;

    scheduleEdgeFadeUpdate();

    let resizeObserver: ResizeObserver | null = null;
    if ('ResizeObserver' in window) {
      resizeObserver = new ResizeObserver(scheduleEdgeFadeUpdate);
      resizeObserver.observe(node);
      if (node.firstElementChild) {
        resizeObserver.observe(node.firstElementChild);
      }
    }

    return () => {
      resizeObserver?.disconnect();
      if (frameRef.current !== null) {
        cancelScrollFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [edgeFade, scheduleEdgeFadeUpdate, updateEdgeFadeState]);

  return (
    <ScrollAreaPrimitive.Root
      ref={ref}
      className={cn('relative overflow-hidden', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        className="h-full w-full rounded-[inherit]"
        onScroll={scheduleEdgeFadeUpdate}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      {edgeFadeState.top && (
        <div className="scroll-fade-edge scroll-fade-edge-top" aria-hidden="true" />
      )}
      {edgeFadeState.bottom && (
        <div className="scroll-fade-edge scroll-fade-edge-bottom" aria-hidden="true" />
      )}
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
});
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

const ScrollBar = React.forwardRef<
  React.ComponentRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = 'vertical', ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    className={cn(
      'flex touch-none select-none transition-colors',
      orientation === 'vertical' && 'h-full w-2.5 border-l border-l-transparent p-[1px]',
      orientation === 'horizontal' && 'h-2.5 flex-col border-t border-t-transparent p-[1px]',
      className,
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb className="bg-border relative flex-1 rounded-full" />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
));
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

export { ScrollArea, ScrollBar };
