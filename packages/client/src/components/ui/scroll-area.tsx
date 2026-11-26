import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area';
import * as React from 'react';

import { cn } from '@/lib/utils';

/** Surface of the scroll box: none, a muted code well, or a rule above it (tool card output). */
const SCROLL_AREA_VARIANT = {
  default: '',
  muted: 'rounded bg-muted',
  'muted-outline': 'rounded border border-border bg-muted',
  // A code well with a faint frame (a failed workflow step's error output).
  'muted-outline-faint': 'rounded border border-border/50 bg-muted',
  divided: 'border-t border-border/40',
  // A list pane beside a detail pane.
  'divided-end': 'border-r',
  // A document outline beside its content: a faint rule on the end, 12px above and below.
  outline: 'border-r border-border/40 py-3',
  // The output well of a failed step.
  destructive: 'rounded bg-destructive/5',
  // A short list with a little room above and below it.
  'inset-y': 'py-1',
  // A log or console: small monospace text, inherited by everything inside.
  code: 'font-mono text-xs',
} as const;

interface ScrollAreaProps extends React.ComponentProps<typeof ScrollAreaPrimitive.Root> {
  edgeFade?: boolean;
  variant?: keyof typeof SCROLL_AREA_VARIANT;
  viewportRef?: React.Ref<HTMLDivElement>;
  viewportProps?: Omit<
    React.ComponentProps<typeof ScrollAreaPrimitive.Viewport>,
    'ref' | 'children'
  > &
    React.HTMLAttributes<HTMLDivElement>;
}

function ScrollArea({
  className,
  children,
  edgeFade: _edgeFade,
  variant = 'default',
  viewportRef,
  viewportProps,
  ...props
}: ScrollAreaProps) {
  const {
    className: viewportClassName,
    onScroll: onViewportScroll,
    ...restViewportProps
  } = viewportProps ?? {};

  const handleViewportScroll: React.UIEventHandler<HTMLDivElement> = (event) => {
    onViewportScroll?.(event);
  };

  return (
    <ScrollAreaPrimitive.Root
      className={cn('relative overflow-hidden', SCROLL_AREA_VARIANT[variant], className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        data-slot="scroll-area-viewport"
        className={cn(
          'h-full w-full rounded-[inherit] [&>div]:block! [&>div]:min-w-0!',
          viewportClassName,
        )}
        onScroll={handleViewportScroll}
        {...restViewportProps}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollBar orientation="horizontal" />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}
function ScrollBar({
  className,
  orientation = 'vertical',
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Scrollbar>) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      orientation={orientation}
      className={cn(
        'flex touch-none select-none transition-colors',
        orientation === 'vertical' &&
          'absolute top-0 right-0 bottom-0 h-full w-[var(--scrollbar-size)]',
        orientation === 'horizontal' &&
          'absolute right-0 bottom-0 left-0 h-[var(--scrollbar-size)] flex-col',
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb className="bg-border relative flex-1 rounded-full" />
    </ScrollAreaPrimitive.Scrollbar>
  );
}
export { ScrollArea };
