import { cn } from '@/lib/utils';

interface CountBadgeProps {
  count: number;
  className?: string;
  'data-testid'?: string;
}

/**
 * Small numeric badge overlaid on the top-right corner of an icon button
 * (unpushed / unpulled commit counts, etc.). Centered with balanced
 * horizontal padding so multi-digit counts ("13") don't crowd the edges,
 * and `tabular-nums` keeps the digits evenly spaced.
 */
export function CountBadge({ count, className, ...props }: CountBadgeProps) {
  return (
    <span
      className={cn(
        'absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] leading-none font-bold tabular-nums text-white',
        className,
      )}
      data-testid={props['data-testid']}
    >
      {count}
    </span>
  );
}
