import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center justify-center rounded-full border font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive transition-[color,box-shadow] overflow-hidden',
  {
    variants: {
      variant: {
        default:
          'border-transparent bg-primary text-primary-foreground shadow-sm hover:bg-primary/80',
        secondary:
          'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
        destructive:
          'border-transparent bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/80',
        outline:
          'border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
        // Tinted status pills: the status color on a 15% wash of itself.
        success: 'border-transparent bg-status-success/15 text-status-success',
        warning: 'border-transparent bg-status-warning/15 text-status-warning',
        error: 'border-transparent bg-status-error/15 text-status-error',
        info: 'border-transparent bg-status-info/15 text-status-info',
        violet: 'border-transparent bg-status-violet/15 text-status-violet',
        // A quiet role or state pill, one step below secondary.
        muted: 'border-transparent bg-muted text-muted-foreground hover:bg-secondary/80',
        // The muted pill with no hover: a label that does nothing when pointed at.
        subtle: 'border-transparent bg-muted text-muted-foreground',
        // An outlined pill that reads as secondary (read-only).
        'outline-muted':
          'border-border text-muted-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
      },
      size: {
        default: 'px-2.5 py-0.5 text-base',
        sm: 'px-2 py-0.5 text-sm',
        xs: 'px-1.5 py-0 text-xs [&>svg]:size-2.5',
        xxs: 'px-1 py-0 text-2xs [&>svg]:size-2',
        // Status chips in dense panels (the background-activity list).
        '3xs': 'rounded px-1 py-0 text-3xs leading-none',
        // Several icon + count stats grouped in one chip (a thread's git state).
        'stat-group': 'gap-1.5 px-1 py-0.5 text-2xs leading-none',
        // A count beside a label (unread items).
        count: 'px-1 py-0.5 text-base leading-none',
      },
      // A pill that labels metadata (a path, a filter) rather than a state.
      weight: {
        default: '',
        normal: 'font-normal',
      },
      // Paths, commands, build numbers: values read character by character.
      mono: {
        true: 'font-mono',
        false: '',
      },
      // Square-cornered tag (a transport, a scope) instead of a round pill.
      corners: {
        pill: '',
        square: 'rounded-md',
      },
      // Short all-caps tag text.
      caps: {
        true: 'uppercase tracking-wider',
        false: '',
      },
      // A chip that removes its item when clicked.
      removable: {
        true: 'cursor-pointer hover:bg-destructive/10 hover:text-status-error',
        false: '',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
      weight: 'default',
      mono: false,
      corners: 'pill',
      caps: false,
      removable: false,
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({
  className,
  variant,
  size,
  weight,
  mono,
  corners,
  caps,
  removable,
  ...props
}: BadgeProps) {
  return (
    <div
      data-slot="badge"
      className={cn(
        badgeVariants({ variant, size, weight, mono, corners, caps, removable }),
        className,
      )}
      {...props}
    />
  );
}

export { Badge };
