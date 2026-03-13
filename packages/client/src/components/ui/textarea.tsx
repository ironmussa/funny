import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

const textareaVariants = cva(
  'flex w-full rounded-md border border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      size: {
        default: 'min-h-[80px] px-3 py-2 text-base',
        xs: 'min-h-[60px] px-2 py-1 text-xs',
        sm: 'min-h-[70px] px-3 py-1.5 text-sm',
      },
    },
    defaultVariants: {
      size: 'default',
    },
  },
);

export interface TextareaProps
  extends Omit<React.ComponentProps<'textarea'>, 'size'>, VariantProps<typeof textareaVariants> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, size, ...props }, ref) => {
    return <textarea className={cn(textareaVariants({ size }), className)} ref={ref} {...props} />;
  },
);
Textarea.displayName = 'Textarea';

export { Textarea, textareaVariants };
