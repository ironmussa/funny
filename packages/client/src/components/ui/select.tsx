import { Select as SelectPrimitive } from '@base-ui/react/select';
import { cva, type VariantProps } from 'class-variance-authority';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import * as React from 'react';

import { FIELD_SIZE } from '@/components/ui/control-size';
import { cn } from '@/lib/utils';

function collectSelectItems(node: React.ReactNode, acc: Record<string, React.ReactNode>): void {
  React.Children.forEach(node, (child) => {
    if (!React.isValidElement<{ value?: string; children?: React.ReactNode }>(child)) {
      return;
    }
    if (child.type === SelectItem && child.props.value !== undefined) {
      acc[child.props.value] = child.props.children;
      return;
    }
    if (child.props.children) {
      collectSelectItems(child.props.children, acc);
    }
  });
}

type SelectProps = Omit<
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Root<string>>,
  'onValueChange' | 'value' | 'defaultValue'
> & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
};

function Select({ children, items, onValueChange, ...props }: SelectProps) {
  const inferredItems = React.useMemo(() => {
    if (items !== undefined) return items;
    const map: Record<string, React.ReactNode> = {};
    collectSelectItems(children, map);
    return Object.keys(map).length > 0 ? map : undefined;
  }, [children, items]);

  return (
    <SelectPrimitive.Root
      items={inferredItems}
      onValueChange={
        onValueChange
          ? (nextValue) => {
              if (nextValue !== null) {
                onValueChange(nextValue);
              }
            }
          : undefined
      }
      {...props}
    >
      {children}
    </SelectPrimitive.Root>
  );
}

const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

const selectTriggerVariants = cva(
  'flex items-center justify-between gap-1 rounded-md border border-input bg-background placeholder:text-muted-foreground data-placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1 hover:bg-accent/50 cursor-pointer',
  {
    // Height / padding / text from the shared control scale so a select trigger
    // lines up with an input or button of the same `size`. See control-size.ts.
    variants: {
      size: {
        xs: FIELD_SIZE.xs,
        sm: FIELD_SIZE.sm,
        md: FIELD_SIZE.md,
        lg: FIELD_SIZE.lg,
      },
      // A trigger drawn as plain text inside a toolbar.
      variant: {
        default: '',
        ghost: 'border-none bg-transparent shadow-none',
      },
      // Text size only, keeping the size's height and padding.
      textSize: {
        default: '',
        '2xs': 'text-2xs',
        compact: 'text-compact',
        xs: 'text-xs',
        sm: 'text-sm',
      },
    },
    defaultVariants: {
      size: 'sm',
      variant: 'default',
      textSize: 'default',
    },
  },
);

function SelectTrigger({
  className,
  children,
  size,
  variant,
  textSize,
  hideChevron,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> &
  VariantProps<typeof selectTriggerVariants> & { hideChevron?: boolean } & {
    ref?: React.Ref<HTMLButtonElement>;
  }) {
  return (
    <SelectPrimitive.Trigger
      ref={ref}
      className={cn(selectTriggerVariants({ size, variant, textSize }), className)}
      {...props}
    >
      {children}
      {!hideChevron && (
        <SelectPrimitive.Icon className="flex items-center">
          <ChevronDown className={cn(size === 'lg' ? 'icon-base' : 'icon-xs', 'opacity-50')} />
        </SelectPrimitive.Icon>
      )}
    </SelectPrimitive.Trigger>
  );
}

function SelectScrollUpButton({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpArrow> & {
  ref?: React.Ref<HTMLDivElement>;
}) {
  return (
    <SelectPrimitive.ScrollUpArrow
      ref={ref}
      className={cn('flex cursor-default items-center justify-center py-1', className)}
      {...props}
    >
      <ChevronUp className="icon-xs" />
    </SelectPrimitive.ScrollUpArrow>
  );
}

function SelectScrollDownButton({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownArrow> & {
  ref?: React.Ref<HTMLDivElement>;
}) {
  return (
    <SelectPrimitive.ScrollDownArrow
      ref={ref}
      className={cn('flex cursor-default items-center justify-center py-1', className)}
      {...props}
    >
      <ChevronDown className="icon-xs" />
    </SelectPrimitive.ScrollDownArrow>
  );
}

type SelectPositionerProps = React.ComponentPropsWithoutRef<typeof SelectPrimitive.Positioner>;

type SelectContentProps = React.ComponentPropsWithoutRef<typeof SelectPrimitive.Popup> &
  Pick<
    SelectPositionerProps,
    'side' | 'align' | 'sideOffset' | 'alignOffset' | 'collisionPadding'
  > & {
    position?: 'popper' | 'item-aligned';
    ref?: React.Ref<HTMLDivElement>;
  };

function SelectContent({
  className,
  children,
  position = 'popper',
  side,
  align,
  sideOffset = 4,
  alignOffset,
  collisionPadding,
  ref,
  ...props
}: SelectContentProps) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionPadding={collisionPadding}
        alignItemWithTrigger={position !== 'popper'}
        className="z-50"
      >
        <SelectPrimitive.Popup
          ref={ref}
          className={cn(
            'relative z-50 max-h-96 min-w-32 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
            position === 'popper' && 'w-full min-w-(--anchor-width)',
            className,
          )}
          {...props}
        >
          <SelectScrollUpButton />
          <SelectPrimitive.List className="p-1">{children}</SelectPrimitive.List>
          <SelectScrollDownButton />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({
  className,
  size = 'default',
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.GroupLabel> & {
  ref?: React.Ref<HTMLDivElement>;
  /** `2xs` for the group headings of dense menus. */
  size?: 'default' | '2xs';
}) {
  return (
    <SelectPrimitive.GroupLabel
      ref={ref}
      className={cn(
        'px-2 py-1.5 font-semibold',
        size === '2xs' ? 'text-2xs' : 'text-xs',
        className,
      )}
      {...props}
    />
  );
}

const selectItemVariants = cva(
  'relative flex w-full cursor-pointer select-none items-center rounded-sm outline-hidden hover:bg-accent/50 data-highlighted:bg-accent data-highlighted:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50',
  {
    // Option rows mirror the trigger's `size` text scale (no height — they
    // size to content). See control-size.ts for the shared scale.
    variants: {
      size: {
        xs: 'py-1 pl-2 pr-6 text-xs',
        sm: 'py-1.5 pl-2 pr-8 text-sm',
        md: 'py-1.5 pl-2 pr-8 text-sm',
        lg: 'py-1.5 pl-2 pr-8 text-base',
      },
      // Text size only, keeping the size's height and padding.
      textSize: {
        default: '',
        '2xs': 'text-2xs',
        compact: 'text-compact',
        xs: 'text-xs',
        sm: 'text-sm',
      },
    },
    defaultVariants: {
      size: 'sm',
      textSize: 'default',
    },
  },
);

function SelectItem({
  className,
  children,
  size,
  textSize,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item> &
  VariantProps<typeof selectItemVariants> & {
    ref?: React.Ref<HTMLDivElement>;
  }) {
  return (
    <SelectPrimitive.Item
      ref={ref}
      className={cn(selectItemVariants({ size, textSize }), className)}
      {...props}
    >
      <span
        className={cn(
          'absolute flex items-center justify-center',
          size === 'xs' ? 'right-1.5 h-3 w-3' : 'right-2 h-3.5 w-3.5',
        )}
      >
        <SelectPrimitive.ItemIndicator>
          <Check className={cn(size === 'xs' ? 'icon-2xs' : 'icon-xs')} />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator> & {
  ref?: React.Ref<HTMLDivElement>;
}) {
  return (
    <SelectPrimitive.Separator
      ref={ref}
      className={cn('-mx-1 my-1 h-px bg-muted', className)}
      {...props}
    />
  );
}

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  selectTriggerVariants,
};
