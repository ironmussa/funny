import * as PopoverPrimitive from '@radix-ui/react-popover';
import type * as React from 'react';

import { cn } from '@/lib/utils';

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;

/** Inner padding: `default` for prose, the tighter steps for menus and lists that pad their own rows. */
const POPOVER_PADDING = {
  default: 'p-4',
  md: 'p-3',
  sm: 'p-2',
  xs: 'p-1',
  none: 'p-0',
} as const;

function PopoverContent({
  className,
  align = 'center',
  sideOffset = 4,
  padding = 'default',
  animated = true,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> & {
  ref?: React.Ref<React.ComponentRef<typeof PopoverPrimitive.Content>>;
  padding?: keyof typeof POPOVER_PADDING;
  /** `false` opens and closes at once (a menu toggled often). */
  animated?: boolean;
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-50 w-72 rounded-md border bg-card shadow-md outline-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
          POPOVER_PADDING[padding],
          !animated && 'data-[state=closed]:animate-none data-[state=open]:animate-none',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverContent };
