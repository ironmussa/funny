import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group';
import { type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { toggleVariants } from '@/components/ui/toggle';
import { cn } from '@/lib/utils';

const ToggleGroupContext = React.createContext<VariantProps<typeof toggleVariants>>({
  size: 'default',
  variant: 'default',
});

function ToggleGroup({
  className,
  variant,
  size,
  segmented = false,
  children,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root> &
  VariantProps<typeof toggleVariants> & {
    ref?: React.Ref<React.ComponentRef<typeof ToggleGroupPrimitive.Root>>;
    /** One framed control with the items side by side, no gap between them. */
    segmented?: boolean;
  }) {
  const contextValue = React.useMemo(() => ({ variant, size }), [variant, size]);

  return (
    <ToggleGroupPrimitive.Root
      ref={ref}
      className={cn(
        'flex items-center justify-center gap-1',
        segmented && 'gap-0 rounded-md border border-border',
        className,
      )}
      {...props}
    >
      <ToggleGroupContext.Provider value={contextValue}>{children}</ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  );
}
function ToggleGroupItem({
  className,
  children,
  variant,
  size,
  truncate,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item> &
  VariantProps<typeof toggleVariants> & {
    ref?: React.Ref<React.ComponentRef<typeof ToggleGroupPrimitive.Item>>;
  }) {
  const context = React.useContext(ToggleGroupContext);

  return (
    <ToggleGroupPrimitive.Item
      ref={ref}
      className={cn(
        toggleVariants({
          variant: variant || context.variant,
          size: size || context.size,
          truncate,
        }),
        className,
      )}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Item>
  );
}
export { ToggleGroup, ToggleGroupItem };
