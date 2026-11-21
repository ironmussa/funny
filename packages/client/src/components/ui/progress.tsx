import * as ProgressPrimitive from '@radix-ui/react-progress';
import * as React from 'react';

import { cn } from '@/lib/utils';

const TONE_CLASS = {
  default: 'bg-primary',
  warning: 'bg-status-warning',
  error: 'bg-status-error',
} as const;

const SIZE_CLASS = {
  default: 'h-4',
  thin: 'h-1.5',
} as const;

interface ProgressProps extends React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> {
  /** Indicator color: `warning` / `error` for a value nearing or at a limit. */
  tone?: keyof typeof TONE_CLASS;
  size?: keyof typeof SIZE_CLASS;
}

const Progress = React.forwardRef<React.ElementRef<typeof ProgressPrimitive.Root>, ProgressProps>(
  ({ className, value, tone = 'default', size = 'default', ...props }, ref) => (
    <ProgressPrimitive.Root
      ref={ref}
      className={cn(
        'relative w-full overflow-hidden rounded-full bg-secondary',
        SIZE_CLASS[size],
        className,
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className={cn('h-full w-full flex-1 transition-all', TONE_CLASS[tone])}
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  ),
);
Progress.displayName = ProgressPrimitive.Root.displayName;

export { Progress };
