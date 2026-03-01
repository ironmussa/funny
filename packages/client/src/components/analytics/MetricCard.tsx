import { cn } from '@/lib/utils';

interface Props {
  title: string;
  value: number | string;
  icon: React.ReactNode;
  color: 'blue' | 'green' | 'amber' | 'gray' | 'violet' | 'red';
}

const colorClasses: Record<string, string> = {
  blue: 'bg-status-info/10 text-status-info/80',
  green: 'bg-status-success/10 text-status-success/80',
  amber: 'bg-status-warning/10 text-status-warning/80',
  gray: 'bg-status-neutral/10 text-status-neutral/80',
  violet: 'bg-status-violet/10 text-status-violet/80',
  red: 'bg-status-error/10 text-status-error/80',
};

export function MetricCard({ title, value, icon, color }: Props) {
  return (
    <div className="rounded-lg border border-border p-4" data-testid={`analytics-metric-${color}`}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{title}</span>
        <div className={cn('p-1.5 rounded-md', colorClasses[color])}>{icon}</div>
      </div>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  );
}
