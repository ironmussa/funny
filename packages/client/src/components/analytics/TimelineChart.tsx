import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

interface DataPoint {
  date: string;
  count: number;
}

interface Props {
  created: DataPoint[];
  completed: DataPoint[];
  movedToReview: DataPoint[];
  movedToDone: DataPoint[];
  groupBy?: 'day' | 'week' | 'month' | 'year';
}

export function TimelineChart({ created, completed, movedToReview, movedToDone, groupBy = 'day' }: Props) {
  const { t } = useTranslation();

  const chartData = useMemo(() => {
    const dateMap = new Map<string, {
      date: string;
      created: number;
      completed: number;
      movedToReview: number;
      movedToDone: number;
    }>();

    for (const item of created) {
      dateMap.set(item.date, { date: item.date, created: item.count, completed: 0, movedToReview: 0, movedToDone: 0 });
    }

    for (const item of completed) {
      const existing = dateMap.get(item.date);
      if (existing) {
        existing.completed = item.count;
      } else {
        dateMap.set(item.date, { date: item.date, created: 0, completed: item.count, movedToReview: 0, movedToDone: 0 });
      }
    }

    for (const item of movedToReview) {
      const existing = dateMap.get(item.date);
      if (existing) {
        existing.movedToReview = item.count;
      } else {
        dateMap.set(item.date, { date: item.date, created: 0, completed: 0, movedToReview: item.count, movedToDone: 0 });
      }
    }

    for (const item of movedToDone) {
      const existing = dateMap.get(item.date);
      if (existing) {
        existing.movedToDone = item.count;
      } else {
        dateMap.set(item.date, { date: item.date, created: 0, completed: 0, movedToReview: 0, movedToDone: item.count });
      }
    }

    return Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [created, completed, movedToReview, movedToDone]);

  if (chartData.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-8 text-sm">
        {t('analytics.noData')}
      </div>
    );
  }

  // Format date labels based on groupBy granularity
  const formatDate = (date: any) => {
    const dateStr = String(date);
    if (groupBy === 'year') {
      return dateStr; // Already in YYYY format
    }
    if (groupBy === 'month') {
      // Format: YYYY-MM -> MMM YYYY
      const [year, month] = dateStr.split('-');
      const d = new Date(parseInt(year), parseInt(month) - 1, 1);
      return d.toLocaleDateString('default', { month: 'short', year: 'numeric' });
    }
    if (groupBy === 'week') {
      // Format: YYYY-WXX -> Week XX, YYYY
      const match = dateStr.match(/(\d{4})-W(\d+)/);
      if (match) {
        return `W${match[2]}, ${match[1]}`;
      }
      return dateStr;
    }
    // Day format: YYYY-MM-DD -> DD/MM
    const d = new Date(date + 'T00:00:00');
    return `${d.getDate()}/${d.getMonth() + 1}`;
  };

  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={chartData} barGap={2}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis
          dataKey="date"
          tickFormatter={formatDate}
          stroke="hsl(var(--muted-foreground))"
          tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          stroke="hsl(var(--muted-foreground))"
          tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: 'hsl(var(--popover))',
            border: '1px solid hsl(var(--border))',
            borderRadius: '6px',
            fontSize: '12px',
            color: 'hsl(var(--foreground))',
          }}
          labelFormatter={formatDate}
        />
        <Legend
          wrapperStyle={{ fontSize: '12px' }}
        />
        <Bar
          dataKey="created"
          fill="#3b82f6"
          name={t('analytics.created')}
          radius={[3, 3, 0, 0]}
          maxBarSize={32}
        />
        <Bar
          dataKey="completed"
          fill="#22c55e"
          name={t('analytics.completed')}
          radius={[3, 3, 0, 0]}
          maxBarSize={32}
        />
        <Bar
          dataKey="movedToReview"
          fill="#f59e0b"
          name={t('analytics.movedToReview')}
          radius={[3, 3, 0, 0]}
          maxBarSize={32}
        />
        <Bar
          dataKey="movedToDone"
          fill="#8b5cf6"
          name={t('analytics.movedToDone')}
          radius={[3, 3, 0, 0]}
          maxBarSize={32}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
