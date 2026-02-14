import { cn } from '@/lib/utils';

interface Props {
  title: string;
  value: number | string;
  icon: React.ReactNode;
  color: 'blue' | 'green' | 'amber' | 'gray' | 'violet' | 'red';
}

const colorClasses: Record<string, string> = {
  blue: 'bg-blue-500/10 text-blue-500',
  green: 'bg-green-500/10 text-green-500',
  amber: 'bg-amber-500/10 text-amber-500',
  gray: 'bg-gray-500/10 text-gray-500',
  violet: 'bg-violet-500/10 text-violet-500',
  red: 'bg-red-500/10 text-red-500',
};

export function MetricCard({ title, value, icon, color }: Props) {
  return (
    <div className="border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-muted-foreground">{title}</span>
        <div className={cn('p-1.5 rounded-md', colorClasses[color])}>
          {icon}
        </div>
      </div>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  );
}
