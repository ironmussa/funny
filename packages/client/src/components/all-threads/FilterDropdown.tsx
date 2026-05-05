import { Check, ChevronDown } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

interface Props {
  label: string;
  options: { value: string; label: string }[];
  selected: Set<string>;
  onToggle: (value: string) => void;
  counts?: Record<string, number>;
  testId?: string;
}

/**
 * Multi-select chip + popover used for status / sync-state filtering in
 * AllThreadsView. Extracted so the parent doesn't import Popover + the
 * ChevronDown / Check icons just for this component.
 */
export function FilterDropdown({ label, options, selected, onToggle, counts, testId }: Props) {
  const activeCount = selected.size;
  const triggerLabel =
    activeCount === 0
      ? label
      : activeCount === 1
        ? (options.find((o) => selected.has(o.value))?.label ?? label)
        : `${label} (${activeCount})`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          data-testid={testId}
          className={cn(
            'inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors whitespace-nowrap',
            activeCount > 0
              ? 'bg-accent text-accent-foreground border-accent-foreground/20'
              : 'bg-transparent text-muted-foreground border-border hover:bg-accent/50 hover:text-foreground',
          )}
        >
          {triggerLabel}
          <ChevronDown className="icon-xs opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto min-w-[160px] p-1">
        {options.map((opt) => {
          const isActive = selected.has(opt.value);
          const count = counts?.[opt.value];
          return (
            <button
              key={opt.value}
              onClick={() => onToggle(opt.value)}
              className={cn(
                'flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-sm transition-colors text-left',
                'hover:bg-accent hover:text-accent-foreground',
                isActive && 'text-accent-foreground',
              )}
            >
              <span
                className={cn(
                  'flex h-3.5 w-3.5 items-center justify-center rounded-sm border',
                  isActive
                    ? 'bg-primary border-primary text-primary-foreground'
                    : 'border-muted-foreground/30',
                )}
              >
                {isActive && <Check className="icon-2xs" />}
              </span>
              <span className="flex-1">{opt.label}</span>
              {count != null && count > 0 && (
                <span className="tabular-nums text-muted-foreground">{count}</span>
              )}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
