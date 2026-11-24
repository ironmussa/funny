import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

const textareaVariants = cva(
  'flex w-full rounded-md border border-input bg-background placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      size: {
        default: 'min-h-[80px] px-3 py-2 text-base',
        xs: 'min-h-[60px] px-2 py-1 text-xs',
        sm: 'min-h-[70px] px-3 py-1.5 text-sm',
      },
      // Code, prompts and config: values read character by character.
      mono: {
        true: 'font-mono',
        false: '',
      },
      // A field filling an editor pane, with no frame of its own.
      variant: {
        default: '',
        bare: 'rounded-none border-0 focus-visible:ring-0',
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
      size: 'default',
      mono: false,
      variant: 'default',
      textSize: 'default',
    },
  },
);

export interface TextareaProps
  extends Omit<React.ComponentProps<'textarea'>, 'size'>, VariantProps<typeof textareaVariants> {}

function Textarea({
  className,
  size,
  mono,
  variant,
  textSize,
  ref,
  ...props
}: TextareaProps & { ref?: React.Ref<HTMLTextAreaElement> }) {
  return (
    <textarea
      className={cn(textareaVariants({ size, mono, variant, textSize }), className)}
      ref={ref}
      {...props}
    />
  );
}
export { Textarea };
