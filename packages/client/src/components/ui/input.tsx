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
        // The `sm` height with tight side padding.
        'sm-tight': 'h-8 px-2 text-sm',
        // Grows with its text: the fields of the settings edit forms.
        form: 'h-auto px-3 py-1.5 text-sm',
        // The edit-form field at the `xs` size.
        'form-xs': 'h-auto px-2 py-1.5 text-xs',
        // A 20px field edited in place (renaming a tab).
        inline: 'h-5 px-1 py-0 text-xs',
      },
      // Paths, commands, branch names and other values read character by character.
      mono: {
        true: 'font-mono',
        false: '',
        // The file explorer's monospace font.
        explorer: 'font-mono-explorer',
      },
      // Room on the left for a search (or other) icon drawn over the field.
      inset: {
        none: '',
        icon: 'pl-8',
        // A smaller leading icon.
        'icon-sm': 'pl-7',
        // A trailing button over the field (show password).
        'icon-end': 'pr-10',
      },
      // Inline field drawn inside another control (a picker's search row).
      variant: {
        default: '',
        bare: 'rounded-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0',
        'bare-strong':
          'rounded-none border-0 bg-transparent p-0 text-foreground shadow-none focus-visible:ring-0',
      },
      // A name the row is about (a group name), not a value.
      weight: {
        default: '',
        medium: 'font-medium',
      },
      // A field on a phone: a 48px target, and 16px text so iOS Safari does not zoom in.
      touch: {
        // ui-rules-allow: iOS Safari zooms into inputs below 16px, whatever the font size setting.
        true: 'min-h-[48px] text-[16px]',
        false: '',
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
      mono: false,
      inset: 'none',
      variant: 'default',
      textSize: 'default',
      weight: 'default',
      touch: false,
    },
  },
);

function Input({
  className,
  type,
  size,
  mono,
  inset,
  variant,
  textSize,
  weight,
  touch,
  ref,
  ...props
}: Omit<React.ComponentProps<'input'>, 'size'> &
  VariantProps<typeof inputVariants> & { ref?: React.Ref<HTMLInputElement> }) {
  return (
    <input
      type={type}
      className={cn(
        inputVariants({ size, mono, inset, variant, textSize, weight, touch }),
        className,
      )}
      ref={ref}
      {...props}
    />
  );
}
export { Input, inputVariants };
