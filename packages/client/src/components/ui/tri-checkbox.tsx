import { Check, Minus } from 'lucide-react';

import { cn } from '@/lib/utils';

type TriCheckboxState = 'checked' | 'unchecked' | 'indeterminate';

interface TriCheckboxProps {
  state: TriCheckboxState;
  onToggle?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  size?: 'sm' | 'default';
  className?: string;
  'data-testid'?: string;
  'aria-label'?: string;
}

export function TriCheckbox({
  state,
  onToggle,
  size = 'default',
  className,
  'data-testid': testId,
  'aria-label': ariaLabel,
}: TriCheckboxProps) {
  const sizeClass = size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5';
  const iconClass = size === 'sm' ? 'h-2 w-2' : 'icon-2xs';

  return (
    <button
      role="checkbox"
      aria-checked={state === 'indeterminate' ? 'mixed' : state === 'checked'}
      aria-label={ariaLabel}
      onClick={onToggle}
      className={cn(
        'flex items-center justify-center cursor-pointer rounded border transition-colors shrink-0',
        sizeClass,
        // oxlint-disable-next-line anti-slop-effect/prefer-effect-match -- plain literal ternary, not an Effect tagged union
        state === 'checked'
          ? 'bg-primary border-primary text-primary-foreground'
          : state === 'indeterminate'
            ? 'bg-muted border-muted-foreground/60 text-foreground'
            : 'bg-transparent border-muted-foreground/40',
        className,
      )}
      data-testid={testId}
    >
      {
        // oxlint-disable-next-line anti-slop-effect/prefer-effect-match -- plain literal ternary, not an Effect tagged union
        state === 'indeterminate' ? (
          <Minus className={cn(iconClass, 'stroke-3')} />
        ) : state === 'checked' ? (
          <Check className={iconClass} />
        ) : null
      }
    </button>
  );
}
