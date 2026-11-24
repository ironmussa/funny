import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import * as React from 'react';

import { cn } from '@/lib/utils';

/** Surface of the scroll box: none, a muted code well, or a rule above it (tool card output). */
const SCROLL_AREA_VARIANT = {
  default: '',
  muted: 'rounded bg-muted',
  'muted-outline': 'rounded border border-border bg-muted',
  divided: 'border-t border-border/40',
  // A list pane beside a detail pane.
  'divided-end': 'border-r',
  // The output well of a failed step.
  destructive: 'rounded bg-destructive/5',
  // A short list with a little room above and below it.
  'inset-y': 'py-1',
  // A log or console: small monospace text, inherited by everything inside.
  code: 'font-mono text-xs',
} as const;

interface ScrollAreaProps extends React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> {
  edgeFade?: boolean;
  variant?: keyof typeof SCROLL_AREA_VARIANT;
  viewportRef?: React.Ref<HTMLDivElement>;
  viewportProps?: Omit<
    React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Viewport>,
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
  ref,
  ...props
}: ScrollAreaProps & { ref?: React.Ref<React.ComponentRef<typeof ScrollAreaPrimitive.Root>> }) {
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
      ref={ref}
      className={cn('relative overflow-hidden', SCROLL_AREA_VARIANT[variant], className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
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
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar> & {
  ref?: React.Ref<React.ComponentRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>>;
}) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      ref={ref}
      orientation={orientation}
      className={cn(
        'flex touch-none select-none transition-colors',
        orientation === 'vertical' && 'h-full w-[var(--scrollbar-size)]',
        orientation === 'horizontal' && 'h-[var(--scrollbar-size)] flex-col',
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb className="bg-border relative flex-1 rounded-full" />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}
export { ScrollArea };
