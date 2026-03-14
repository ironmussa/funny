import { cva } from 'class-variance-authority';
import type { LucideIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

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
  sm: 'h-3.5 w-3.5',
  md: 'h-4 w-4',
} as const;

interface NavItemProps {
  icon: LucideIcon;
  label: string;
  count?: number;
  size?: 'sm' | 'md';
  isActive?: boolean;
  onClick?: () => void;
  'data-testid'?: string;
}

export function NavItem({
  icon: Icon,
  label,
  count,
  size = 'md',
  isActive = false,
  onClick,
  'data-testid': testId,
}: NavItemProps) {
  return (
    <button onClick={onClick} data-testid={testId} className={navItemVariants({ size, isActive })}>
      <Icon className={cn(iconSizes[size], 'shrink-0')} />
      <span className="truncate">{label}</span>
      {count !== undefined && count > 0 && (
        <Badge variant="secondary" size="xs" className="ml-auto shrink-0">
          {count}
        </Badge>
      )}
    </button>
  );
}
