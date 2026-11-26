import { Progress as ProgressPrimitive } from '@base-ui/react/progress';
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

interface ProgressProps extends Omit<React.ComponentProps<typeof ProgressPrimitive.Root>, 'value'> {
  value?: number | null;
  /** Indicator color: `warning` / `error` for a value nearing or at a limit. */
  tone?: keyof typeof TONE_CLASS;
  size?: keyof typeof SIZE_CLASS;
}

function Progress({
  className,
  value = null,
  tone = 'default',
  size = 'default',
  ...props
}: ProgressProps) {
  return (
    <ProgressPrimitive.Root
      value={value}
      className={cn(
        'relative w-full overflow-hidden rounded-full bg-secondary',
        SIZE_CLASS[size],
        className,
      )}
      {...props}
    >
      <ProgressPrimitive.Track className="h-full w-full">
        <ProgressPrimitive.Indicator className={cn('h-full transition-all', TONE_CLASS[tone])} />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  );
}

export { Progress };
