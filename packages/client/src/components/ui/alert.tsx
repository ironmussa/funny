import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

const alertVariants = cva(
  'relative w-full rounded-lg border p-4 [&>svg~*]:pl-7 [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:text-foreground',
  {
    variants: {
      variant: {
        default: 'bg-background text-foreground',
        destructive:
          'border-destructive/50 text-destructive dark:border-destructive [&>svg]:text-destructive',
        // Something to check before going on (unpushed commits, a risky action).
        warning:
          'border-status-warning/30 bg-status-warning/10 text-status-warning [&>svg]:text-status-warning',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Alert({
  className,
  variant,
  ref,
  ...props
}: React.HTMLAttributes<HTMLDivElement> &
  VariantProps<typeof alertVariants> & { ref?: React.Ref<HTMLDivElement> }) {
  return (
    <div ref={ref} role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
  );
}
function AlertDescription({
  className,
  size = 'default',
  ref,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement> & {
  ref?: React.Ref<HTMLParagraphElement>;
  /** `xs` for compact alerts inside dialogs. */
  size?: 'default' | 'xs';
}) {
  return (
    <div
      ref={ref}
      className={cn(size === 'xs' ? 'text-xs' : 'text-sm', '[&_p]:leading-relaxed', className)}
      {...props}
    />
  );
}
export { Alert, AlertDescription };
