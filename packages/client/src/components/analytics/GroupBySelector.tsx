import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

export type GroupBy = 'day' | 'week' | 'month' | 'year';

interface Props {
  value: GroupBy;
  onChange: (value: GroupBy) => void;
}

export function GroupBySelector({ value, onChange }: Props) {
  const { t } = useTranslation();

  const options: { value: GroupBy; label: string }[] = [
    { value: 'day', label: t('analytics.groupByDay') },
    { value: 'week', label: t('analytics.groupByWeek') },
    { value: 'month', label: t('analytics.groupByMonth') },
    { value: 'year', label: t('analytics.groupByYear') },
  ];

  return (
    <div
      className="border-border bg-muted/30 flex rounded-md border p-0.5"
      data-testid="analytics-group-by"
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          data-testid={`analytics-group-by-${opt.value}`}
          onClick={() => onChange(opt.value)}
          className={cn(
            'px-3 py-1.5 text-xs rounded-sm transition-colors whitespace-nowrap',
            value === opt.value
              ? 'bg-background text-foreground shadow-xs'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
