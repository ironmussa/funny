import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';

const sizeClasses = {
  default: {
    root: 'h-4 w-4',
    icon: 'h-4 w-4',
  },
  sm: {
    root: 'h-3.5 w-3.5',
    icon: 'h-3.5 w-3.5',
  },
  xs: {
    root: 'h-3 w-3',
    icon: 'h-3 w-3',
  },
} as const;

type CheckboxSize = keyof typeof sizeClasses;

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root> & { size?: CheckboxSize }
>(({ className, size = 'default', ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      'grid place-content-center peer shrink-0 rounded-sm border border-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
      sizeClasses[size].root,
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className={cn('grid place-content-center text-current')}>
      <Check className={sizeClasses[size].icon} />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
