import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { FIELD_SIZE } from '@/components/ui/control-size';
import { cn } from '@/lib/utils';

const inputVariants = cva(
  'flex w-full rounded-md border border-input bg-background py-1 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
  {
    // Height / padding / text from the shared control scale so an input lines
    // up with a button or select of the same `size`. See control-size.ts.
    variants: {
      size: {
        xs: FIELD_SIZE.xs,
        sm: FIELD_SIZE.sm,
        md: FIELD_SIZE.md,
        lg: FIELD_SIZE.lg,
      },
    },
    defaultVariants: {
      size: 'sm',
    },
  },
);

function Input({
  className,
  type,
  size,
  ref,
  ...props
}: Omit<React.ComponentProps<'input'>, 'size'> &
  VariantProps<typeof inputVariants> & { ref?: React.Ref<HTMLInputElement> }) {
  return (
    <input type={type} className={cn(inputVariants({ size }), className)} ref={ref} {...props} />
  );
}
export { Input, inputVariants };
