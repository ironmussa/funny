import { cva } from 'class-variance-authority';
import type { LucideIcon } from 'lucide-react';
import { forwardRef } from 'react';

import { Badge } from '@/components/ui/badge';
import { cn, ICON_SIZE } from '@/lib/utils';

const navItemVariants = cva('flex w-full items-center gap-2 rounded-md transition-colors', {
  variants: {
    size: {
      sm: 'px-2 py-1 text-xs',
      md: 'px-2 py-1.5 text-sm',
    },
    isActive: {
      true: 'bg-sidebar-accent font-medium text-sidebar-accent-foreground',
      false: 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
    },
  },
  defaultVariants: {
    size: 'md',
    isActive: false,
  },
});

const iconSizes = {
  sm: ICON_SIZE.sm,
  md: ICON_SIZE.base,
} as const;

interface NavItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: string;
  count?: number;
  size?: 'sm' | 'md';
  isActive?: boolean;
}

// forwardRef + prop spread so NavItem can be a Radix `asChild` trigger
// (Popover/Dropdown) — those clone the child with a ref and a11y/state props.
export const NavItem = forwardRef<HTMLButtonElement, NavItemProps>(function NavItem(
  { icon: Icon, label, count, size = 'md', isActive = false, className, ...rest },
  ref,
) {
  return (
    <button ref={ref} className={cn(navItemVariants({ size, isActive }), className)} {...rest}>
      <Icon className={cn(iconSizes[size], 'shrink-0')} />
      <span className="truncate">{label}</span>
      {count !== undefined && count > 0 && (
        <Badge variant="secondary" size="xs" className="ml-auto shrink-0">
          {count}
        </Badge>
      )}
    </button>
  );
});
