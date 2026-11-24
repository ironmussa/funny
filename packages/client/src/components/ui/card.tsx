import * as React from 'react';

import { cn } from '@/lib/utils';

/** Border tint of a card that reports a state (a disabled, failing or warning item). */
const CARD_TONE = {
  default: '',
  disabled: 'border-border/30 opacity-60',
  warning: 'border-status-warning/50',
  error: 'border-status-error/50',
} as const;

type CardProps = React.HTMLAttributes<HTMLDivElement> & {
  /** No shadow: a card laid on a settings page rather than floating over it. */
  flat?: boolean;
  tone?: keyof typeof CARD_TONE;
};

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, flat = false, tone = 'default', ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'rounded-lg border bg-card text-card-foreground shadow-xs',
        flat && 'shadow-none',
        CARD_TONE[tone],
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = 'Card';

/** `sm`: 16px padding for the compact cards of a grid. */
type CardSectionSize = { size?: 'default' | 'sm' };

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & CardSectionSize
>(({ className, size = 'default', ...props }, ref) => (
  <div
    ref={ref}
    className={cn('flex flex-col space-y-1.5 p-6', size === 'sm' && 'p-4 pb-2', className)}
    {...props}
  />
));
CardHeader.displayName = 'CardHeader';

const CardTitle = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & CardSectionSize
>(({ className, size = 'default', ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      'text-2xl font-semibold leading-none tracking-tight',
      size === 'sm' && 'text-sm font-medium leading-snug',
      className,
    )}
    {...props}
  />
));
CardTitle.displayName = 'CardTitle';

const CardDescription = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & CardSectionSize
>(({ className, size = 'default', ...props }, ref) => (
  <div
    ref={ref}
    className={cn('text-sm text-muted-foreground', size === 'sm' && 'text-xs', className)}
    {...props}
  />
));
CardDescription.displayName = 'CardDescription';

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & CardSectionSize
>(({ className, size = 'default', ...props }, ref) => (
  <div
    ref={ref}
    className={cn('flex items-center p-6 pt-0', size === 'sm' && 'p-4 pt-0', className)}
    {...props}
  />
));
CardFooter.displayName = 'CardFooter';

export { Card, CardHeader, CardFooter, CardTitle, CardDescription };
