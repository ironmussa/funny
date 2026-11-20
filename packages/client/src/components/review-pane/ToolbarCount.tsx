import { cn } from '@/lib/utils';

/**
 * The item count every review sub-tab toolbar shows at its right end
 * ("12 commits", "2 worktrees"). The toolbar puts its refresh and action
 * buttons first, then this count.
 */
export function ToolbarCount({
  label,
  className,
  testId,
}: {
  label: string;
  className?: string;
  testId?: string;
}) {
  return (
    <span
      className={cn('text-muted-foreground ml-auto shrink-0 text-[10px] tabular-nums', className)}
      data-testid={testId}
    >
      {label}
    </span>
  );
}
