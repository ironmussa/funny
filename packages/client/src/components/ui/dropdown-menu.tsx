import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { cva, type VariantProps } from 'class-variance-authority';
import { ChevronRight } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';

const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
const DropdownMenuGroup = DropdownMenuPrimitive.Group;
const DropdownMenuPortal = DropdownMenuPrimitive.Portal;
const DropdownMenuSub = DropdownMenuPrimitive.Sub;

const dropdownMenuContentVariants = cva(
  'z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
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

function DropdownMenuContent({
  className,
  sideOffset = 4,
  size,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content> &
  VariantProps<typeof dropdownMenuContentVariants> & {
    ref?: React.Ref<React.ComponentRef<typeof DropdownMenuPrimitive.Content>>;
  }) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(dropdownMenuContentVariants({ size }), className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}
const dropdownMenuItemVariants = cva(
  'relative flex cursor-pointer select-none items-center rounded-sm outline-none transition-colors focus-visible:bg-accent focus-visible:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
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

function DropdownMenuItem({
  className,
  inset,
  size,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> &
  VariantProps<typeof dropdownMenuItemVariants> & {
    inset?: boolean;
  } & { ref?: React.Ref<React.ComponentRef<typeof DropdownMenuPrimitive.Item>> }) {
  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      className={cn(
        dropdownMenuItemVariants({ size }),
        inset && (size === 'xs' ? 'pl-6' : size === 'sm' ? 'pl-7' : 'pl-8'),
        className,
      )}
      {...props}
    />
  );
}
function DropdownMenuSeparator({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator> & {
  ref?: React.Ref<React.ComponentRef<typeof DropdownMenuPrimitive.Separator>>;
}) {
  return (
    <DropdownMenuPrimitive.Separator
      ref={ref}
      className={cn('-mx-1 my-1 h-px bg-muted', className)}
      {...props}
    />
  );
}
const dropdownMenuSubTriggerVariants = cva(
  'flex cursor-pointer select-none items-center rounded-sm outline-none focus-visible:bg-accent data-[state=open]:bg-accent',
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
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> &
  VariantProps<typeof dropdownMenuSubTriggerVariants> & {
    inset?: boolean;
  } & { ref?: React.Ref<React.ComponentRef<typeof DropdownMenuPrimitive.SubTrigger>> }) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      ref={ref}
      className={cn(
        dropdownMenuSubTriggerVariants({ size }),
        inset && (size === 'xs' ? 'pl-6' : size === 'sm' ? 'pl-7' : 'pl-8'),
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}
function DropdownMenuSubContent({
  className,
  size,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent> &
  VariantProps<typeof dropdownMenuContentVariants> & {
    ref?: React.Ref<React.ComponentRef<typeof DropdownMenuPrimitive.SubContent>>;
  }) {
  return (
    <DropdownMenuPrimitive.SubContent
      ref={ref}
      className={cn(
        'z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
        size === 'xs' ? 'p-0.5' : size === 'sm' ? 'p-1' : 'p-1',
        className,
      )}
      {...props}
    />
  );
}
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  dropdownMenuContentVariants,
  dropdownMenuItemVariants,
};
