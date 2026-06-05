import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface RowProps {
  title: string;
  description: string;
  children: ReactNode;
}

/** Setting row: label/description on the left, control on the right. */
export function SettingRow({ title, description, children }: RowProps) {
  return (
    <div className="border-border/50 flex items-center justify-between gap-4 border-b px-4 py-3.5 last:border-b-0">
      <div className="min-w-0">
        <p className="text-foreground text-sm font-medium">{title}</p>
        <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

interface SegmentedControlProps<T extends string> {
  options: { value: T; label: string; icon?: ReactNode; testId?: string }[];
  value: T;
  onChange: (value: T) => void;
}

/** Pill-style segmented control for picking one of a small enum. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: SegmentedControlProps<T>) {
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
