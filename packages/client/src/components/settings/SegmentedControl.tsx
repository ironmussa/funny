import type React from 'react';

import { cn } from '@/lib/utils';

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; icon?: React.ReactNode; testId?: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="border-border bg-muted/30 flex rounded-md border p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          aria-pressed={value === opt.value}
          data-testid={opt.testId}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-sm transition-colors',
            value === opt.value
              ? 'bg-background text-foreground shadow-xs'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {opt.icon}
          {opt.label}
        </button>
      ))}
    </div>
  );
}
