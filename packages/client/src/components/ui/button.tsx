import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import * as React from 'react';

import { CONTROL_ICON, FIELD_SIZE, ICON_SIZE } from '@/components/ui/control-size';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      // Field heights / padding / text come from the shared control scale so a
      // text button lines up with an input or select of the same `size`. The
      // square `icon*` buttons are a separate axis (width === height) and keep
      // their own sizes. See control-size.ts.
      size: {
        default: cn(FIELD_SIZE.sm, CONTROL_ICON.sm), // app default density = 32px
        xs: cn(FIELD_SIZE.xs, CONTROL_ICON.xs),
        sm: cn(FIELD_SIZE.sm, CONTROL_ICON.sm),
        md: cn(FIELD_SIZE.md, CONTROL_ICON.md),
        lg: cn(FIELD_SIZE.lg, CONTROL_ICON.lg),
        icon: cn(ICON_SIZE.lg, CONTROL_ICON.md),
        'icon-xs': cn(ICON_SIZE.xs, CONTROL_ICON.sm),
        'icon-sm': cn(ICON_SIZE.sm, CONTROL_ICON.md),
        'icon-md': cn(ICON_SIZE.md, CONTROL_ICON.md),
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  children,
  disabled,
  ref,
  ...props
}: ButtonProps & { ref?: React.Ref<HTMLButtonElement> }) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      disabled={disabled || loading}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {loading && <Loader2 className="size-4 animate-spin" />}
          {children}
        </>
      )}
    </Comp>
  );
}
export { Button, buttonVariants };
