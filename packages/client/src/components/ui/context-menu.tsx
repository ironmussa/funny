import { ContextMenu as ContextMenuPrimitive } from '@base-ui/react/context-menu';
import * as React from 'react';

import { cn } from '@/lib/utils';

const ContextMenu = ContextMenuPrimitive.Root;

type ContextMenuTriggerProps = React.ComponentPropsWithoutRef<
  typeof ContextMenuPrimitive.Trigger
> & {
  asChild?: boolean;
  ref?: React.Ref<HTMLDivElement>;
};

function ContextMenuTrigger({ asChild, render, children, ref, ...props }: ContextMenuTriggerProps) {
  const childElement = asChild && !render && React.isValidElement(children) ? children : undefined;
  return (
    <ContextMenuPrimitive.Trigger ref={ref} render={render ?? childElement} {...props}>
      {childElement ? undefined : children}
    </ContextMenuPrimitive.Trigger>
  );
}

type ContextMenuPositionerProps = React.ComponentPropsWithoutRef<
  typeof ContextMenuPrimitive.Positioner
>;

type ContextMenuContentProps = React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Popup> &
  Pick<
    ContextMenuPositionerProps,
    'side' | 'align' | 'sideOffset' | 'alignOffset' | 'collisionPadding'
  > & {
    ref?: React.Ref<HTMLDivElement>;
  };

function ContextMenuContent({
  className,
  side,
  align,
  sideOffset,
  alignOffset,
  collisionPadding,
  ref,
  ...props
}: ContextMenuContentProps) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionPadding={collisionPadding}
        className="z-50"
      >
        <ContextMenuPrimitive.Popup
          ref={ref}
          className={cn(
            'z-50 max-h-(--available-height) min-w-32 overflow-y-auto overflow-x-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md animate-in fade-in-80 data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-(--transform-origin)',
            className,
          )}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

function ContextMenuItem({
  className,
  inset,
  // Kept so callers can mark delete items; it no longer changes the look.
  variant: _variant = 'default',
  onClick,
  onSelect,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & {
  inset?: boolean;
  /** `destructive` for an item that closes or deletes something (not tinted red). */
  variant?: 'default' | 'destructive';
  onSelect?: (event: Event) => void;
  ref?: React.Ref<HTMLDivElement>;
}) {
  return (
    <ContextMenuPrimitive.Item
      ref={ref}
      onClick={
        onClick || onSelect
          ? (event) => {
              onClick?.(event);
              onSelect?.(event.nativeEvent);
            }
          : undefined
      }
      className={cn(
        'relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-hidden focus:bg-accent focus:text-accent-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50',
        inset && 'pl-8',
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuSeparator({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator> & {
  ref?: React.Ref<HTMLDivElement>;
}) {
  return (
    <ContextMenuPrimitive.Separator
      ref={ref}
      className={cn('-mx-1 my-1 h-px bg-border', className)}
      {...props}
    />
  );
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
};
