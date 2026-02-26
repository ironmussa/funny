import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

export type TimeRange = 'day' | 'week' | 'month' | 'all';

interface Props {
  value: TimeRange;
  onChange: (value: TimeRange) => void;
}

export function TimeRangeSelector({ value, onChange }: Props) {
  const { t } = useTranslation();

  const options: { value: TimeRange; label: string }[] = [
    { value: 'day', label: t('analytics.day') },
    { value: 'week', label: t('analytics.week') },
    { value: 'month', label: t('analytics.month') },
    { value: 'all', label: t('analytics.all') },
  ];

  return (
    <div className="flex rounded-md border border-border bg-muted/30 p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            'px-3 py-1.5 text-xs rounded-sm transition-colors whitespace-nowrap',
            value === opt.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
