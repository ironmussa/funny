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
const TOOLTIP_VARIANT_CLASSES = {
  default: '',
  /** A full identifier (branch, path, hash, test id): monospace, wrapped at any character. */
  mono: 'max-w-[min(32rem,calc(100vw-2rem))] font-mono break-all',
} as const;

function TooltipContent({
  className,
  sideOffset = 4,
  variant = 'default',
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> & {
  variant?: keyof typeof TOOLTIP_VARIANT_CLASSES;
  ref?: React.Ref<React.ElementRef<typeof TooltipPrimitive.Content>>;
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'z-50 rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md animate-in fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          TOOLTIP_VARIANT_CLASSES[variant],
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}
export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
