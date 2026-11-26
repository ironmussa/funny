import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import * as React from 'react';

import { cn } from '@/lib/utils';

function Popover({
  onOpenChange,
  ...props
}: Omit<React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Root>, 'onOpenChange'> & {
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <PopoverPrimitive.Root
      onOpenChange={onOpenChange ? (open) => onOpenChange(open) : undefined}
      {...props}
    />
  );
}

type PopoverTriggerProps = React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger> & {
  asChild?: boolean;
  ref?: React.Ref<HTMLButtonElement>;
};

function isNonButtonIntrinsicElement(element: React.ReactElement): boolean {
  return String(element.type) === element.type && element.type !== 'button';
}

function PopoverTrigger({
  asChild,
  render,
  children,
  nativeButton,
  ref,
  ...props
}: PopoverTriggerProps) {
  const childElement = asChild && !render && React.isValidElement(children) ? children : undefined;
  const resolvedRender = render ?? childElement;
  const resolvedChildren = childElement ? undefined : children;
  const resolvedNativeButton =
    nativeButton ?? (childElement && isNonButtonIntrinsicElement(childElement) ? false : undefined);

  return (
    <PopoverPrimitive.Trigger
      ref={ref}
      render={resolvedRender}
      nativeButton={resolvedNativeButton}
      {...props}
    >
      {resolvedChildren}
    </PopoverPrimitive.Trigger>
  );
}

/** Inner padding: `default` for prose, the tighter steps for menus and lists that pad their own rows. */
const POPOVER_PADDING = {
  default: 'p-4',
  md: 'p-3',
  sm: 'p-2',
  xs: 'p-1',
  none: 'p-0',
} as const;

function bridgeAutoFocusHandler(handler?: (event: Event) => void) {
  if (!handler) return undefined;
  return () => {
    const event = new CustomEvent('popover.autoFocus', { cancelable: true });
    handler(event);
    return !event.defaultPrevented;
  };
}

type PopoverPositionerProps = React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Positioner>;

type PopoverContentProps = React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Popup> &
  Pick<
    PopoverPositionerProps,
    'side' | 'align' | 'sideOffset' | 'alignOffset' | 'collisionPadding'
  > & {
    ref?: React.Ref<HTMLDivElement>;
    padding?: keyof typeof POPOVER_PADDING;
    /** `false` opens and closes at once (a menu toggled often). */
    animated?: boolean;
    onOpenAutoFocus?: (event: Event) => void;
    onCloseAutoFocus?: (event: Event) => void;
  };

function PopoverContent({
  className,
  side,
  align = 'center',
  sideOffset = 4,
  alignOffset,
  collisionPadding,
  padding = 'default',
  animated = true,
  initialFocus,
  finalFocus,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ref,
  ...props
}: PopoverContentProps) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionPadding={collisionPadding}
        className="z-50"
      >
        <PopoverPrimitive.Popup
          ref={ref}
          initialFocus={initialFocus ?? bridgeAutoFocusHandler(onOpenAutoFocus)}
          finalFocus={finalFocus ?? bridgeAutoFocusHandler(onCloseAutoFocus)}
          className={cn(
            'z-50 w-72 rounded-md border bg-card shadow-md outline-hidden data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
            POPOVER_PADDING[padding],
            !animated && 'data-closed:animate-none data-open:animate-none',
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverContent };
