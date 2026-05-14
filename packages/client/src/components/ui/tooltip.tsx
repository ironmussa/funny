import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as React from 'react';

import { cn } from '@/lib/utils';

const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

function TooltipTrigger({
  onFocusCapture,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger> & {
  ref?: React.Ref<React.ElementRef<typeof TooltipPrimitive.Trigger>>;
}) {
  return (
    <TooltipPrimitive.Trigger
      ref={ref}
      onFocusCapture={(event) => {
        onFocusCapture?.(event);
        if (event.defaultPrevented || event.isPropagationStopped()) return;
        const target = event.target as HTMLElement | null;
        if (target && typeof target.matches === 'function' && !target.matches(':focus-visible')) {
          event.stopPropagation();
        }
      }}
      {...props}
    />
  );
}
function TooltipContent({
  className,
  sideOffset = 4,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> & {
  ref?: React.Ref<React.ElementRef<typeof TooltipPrimitive.Content>>;
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          'z-50 rounded-md border border-white/20 bg-white px-2 py-1 text-xs text-gray-900 shadow-md animate-in fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}
export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
