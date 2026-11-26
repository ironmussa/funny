import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { cva, type VariantProps } from 'class-variance-authority';
import { Check, ChevronRight } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';

const DropdownMenu = MenuPrimitive.Root;
const DropdownMenuGroup = MenuPrimitive.Group;
const DropdownMenuPortal = MenuPrimitive.Portal;
const DropdownMenuSub = MenuPrimitive.SubmenuRoot;

function isNonButtonIntrinsicElement(element: React.ReactElement): boolean {
  return String(element.type) === element.type && element.type !== 'button';
}

type DropdownMenuTriggerProps = React.ComponentPropsWithoutRef<typeof MenuPrimitive.Trigger> & {
  asChild?: boolean;
  ref?: React.Ref<HTMLButtonElement>;
};

function DropdownMenuTrigger({
  asChild,
  render,
  children,
  nativeButton,
  ref,
  ...props
}: DropdownMenuTriggerProps) {
  const childElement = asChild && !render && React.isValidElement(children) ? children : undefined;
  const resolvedRender = render ?? childElement;
  const resolvedChildren = childElement ? undefined : children;
  const resolvedNativeButton =
    nativeButton ?? (childElement && isNonButtonIntrinsicElement(childElement) ? false : undefined);

  return (
    <MenuPrimitive.Trigger
      ref={ref}
      render={resolvedRender}
      nativeButton={resolvedNativeButton}
      {...props}
    >
      {resolvedChildren}
    </MenuPrimitive.Trigger>
  );
}

function bridgeAutoFocusHandler(handler?: (event: Event) => void) {
  if (!handler) return undefined;
  return () => {
    const event = new CustomEvent('menu.autoFocus', { cancelable: true });
    handler(event);
    return !event.defaultPrevented;
  };
}

const dropdownMenuContentVariants = cva(
  'z-50 min-w-32 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
  {
    variants: {
      size: {
        default: 'p-1',
        sm: 'p-1',
        xs: 'p-0.5',
      },
    },
    defaultVariants: {
      size: 'sm',
    },
  },
);

type MenuPositionerProps = React.ComponentPropsWithoutRef<typeof MenuPrimitive.Positioner>;

type DropdownMenuContentProps = React.ComponentPropsWithoutRef<typeof MenuPrimitive.Popup> &
  Pick<MenuPositionerProps, 'side' | 'align' | 'sideOffset' | 'alignOffset' | 'collisionPadding'> &
  VariantProps<typeof dropdownMenuContentVariants> & {
    ref?: React.Ref<HTMLDivElement>;
    onCloseAutoFocus?: (event: Event) => void;
  };

function DropdownMenuContent({
  className,
  side,
  align,
  sideOffset = 4,
  alignOffset,
  collisionPadding,
  size,
  finalFocus,
  onCloseAutoFocus,
  ref,
  ...props
}: DropdownMenuContentProps) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionPadding={collisionPadding}
        className="z-50"
      >
        <MenuPrimitive.Popup
          ref={ref}
          finalFocus={finalFocus ?? bridgeAutoFocusHandler(onCloseAutoFocus)}
          className={cn(dropdownMenuContentVariants({ size }), className)}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

const dropdownMenuItemVariants = cva(
  'relative flex cursor-pointer select-none items-center rounded-sm outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50',
  {
    variants: {
      size: {
        default: 'gap-2 px-2 py-1.5 text-base [&>svg]:size-4 [&>svg]:shrink-0',
        sm: 'gap-2 px-2 py-1.5 text-sm [&>svg]:size-3.5 [&>svg]:shrink-0',
        xs: 'gap-1.5 px-1.5 py-1 text-xs [&>svg]:size-3 [&>svg]:shrink-0',
      },
      // Items that delete or discard. Not tinted red: they look like any other item.
      variant: {
        default: '',
        destructive: '',
      },
    },
    defaultVariants: {
      size: 'sm',
      variant: 'default',
    },
  },
);

function DropdownMenuItem({
  className,
  inset,
  size,
  variant,
  asChild,
  render,
  children,
  onClick,
  onSelect,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof MenuPrimitive.Item> &
  VariantProps<typeof dropdownMenuItemVariants> & {
    inset?: boolean;
    asChild?: boolean;
    onSelect?: (event: Event) => void;
    ref?: React.Ref<HTMLDivElement>;
  }) {
  const childElement = asChild && !render && React.isValidElement(children) ? children : undefined;
  return (
    <MenuPrimitive.Item
      ref={ref}
      render={render ?? childElement}
      onClick={
        onClick || onSelect
          ? (event) => {
              onClick?.(event);
              onSelect?.(event.nativeEvent);
            }
          : undefined
      }
      className={cn(
        dropdownMenuItemVariants({ size, variant }),
        // oxlint-disable-next-line anti-slop-effect/prefer-effect-match -- plain literal ternary, not an Effect tagged union
        inset && (size === 'xs' ? 'pl-6' : size === 'sm' ? 'pl-7' : 'pl-8'),
        className,
      )}
      {...props}
    >
      {childElement ? undefined : children}
    </MenuPrimitive.Item>
  );
}

const dropdownMenuLabelVariants = cva('font-semibold', {
  variants: {
    size: {
      default: 'px-2 py-1.5 text-xs',
      sm: 'px-2 py-1.5 text-xs',
      xs: 'px-1.5 py-1 text-2xs',
    },
  },
  defaultVariants: {
    size: 'sm',
  },
});

function DropdownMenuCheckboxItem({
  className,
  size,
  children,
  onClick,
  onSelect,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof MenuPrimitive.CheckboxItem> &
  VariantProps<typeof dropdownMenuItemVariants> & {
    onSelect?: (event: Event) => void;
    ref?: React.Ref<HTMLDivElement>;
  }) {
  return (
    <MenuPrimitive.CheckboxItem
      ref={ref}
      onClick={
        onClick || onSelect
          ? (event) => {
              onClick?.(event);
              onSelect?.(event.nativeEvent);
            }
          : undefined
      }
      className={cn(dropdownMenuItemVariants({ size }), 'pl-7', className)}
      {...props}
    >
      <span className="absolute left-2 flex size-3.5 items-center justify-center">
        <MenuPrimitive.CheckboxItemIndicator>
          <Check className="size-3.5" />
        </MenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuLabel({
  className,
  inset,
  size,
  ref,
  ...props
}: React.HTMLAttributes<HTMLDivElement> &
  VariantProps<typeof dropdownMenuLabelVariants> & {
    inset?: boolean;
    ref?: React.Ref<HTMLDivElement>;
  }) {
  return (
    <div
      ref={ref}
      data-slot="dropdown-menu-label"
      className={cn(dropdownMenuLabelVariants({ size }), inset && 'pl-8', className)}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof MenuPrimitive.Separator> & {
  ref?: React.Ref<HTMLDivElement>;
}) {
  return (
    <MenuPrimitive.Separator
      ref={ref}
      className={cn('-mx-1 my-1 h-px bg-muted', className)}
      {...props}
    />
  );
}

const dropdownMenuSubTriggerVariants = cva(
  'flex cursor-pointer select-none items-center rounded-sm outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground data-popup-open:bg-accent data-popup-open:text-accent-foreground',
  {
    variants: {
      size: {
        default: 'gap-2 px-2 py-1.5 text-base [&>svg]:size-4 [&>svg]:shrink-0',
        sm: 'gap-2 px-2 py-1.5 text-sm [&>svg]:size-3.5 [&>svg]:shrink-0',
        xs: 'gap-1.5 px-1.5 py-1 text-xs [&>svg]:size-3 [&>svg]:shrink-0',
      },
    },
    defaultVariants: {
      size: 'sm',
    },
  },
);

function DropdownMenuSubTrigger({
  className,
  inset,
  size,
  children,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof MenuPrimitive.SubmenuTrigger> &
  VariantProps<typeof dropdownMenuSubTriggerVariants> & {
    inset?: boolean;
    ref?: React.Ref<HTMLDivElement>;
  }) {
  return (
    <MenuPrimitive.SubmenuTrigger
      ref={ref}
      className={cn(
        dropdownMenuSubTriggerVariants({ size }),
        // oxlint-disable-next-line anti-slop-effect/prefer-effect-match -- plain literal ternary, not an Effect tagged union
        inset && (size === 'xs' ? 'pl-6' : size === 'sm' ? 'pl-7' : 'pl-8'),
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

function DropdownMenuSubContent({
  className,
  size,
  sideOffset = 2,
  alignOffset = -4,
  collisionPadding,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof MenuPrimitive.Popup> &
  Pick<MenuPositionerProps, 'sideOffset' | 'alignOffset' | 'collisionPadding'> &
  VariantProps<typeof dropdownMenuContentVariants> & {
    ref?: React.Ref<HTMLDivElement>;
  }) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionPadding={collisionPadding}
        className="z-50"
      >
        <MenuPrimitive.Popup
          ref={ref}
          className={cn(
            'z-50 min-w-32 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
            // oxlint-disable-next-line anti-slop-effect/prefer-effect-match -- plain literal ternary, not an Effect tagged union
            size === 'xs' ? 'p-0.5' : size === 'sm' ? 'p-1' : 'p-1',
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
