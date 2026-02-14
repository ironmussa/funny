import { useTranslation } from 'react-i18next';
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from 'recharts';

interface Props {
  data: Record<string, number>;
}

const COLORS: Record<string, string> = {
  backlog: '#6b7280',
  in_progress: '#3b82f6',
  review: '#f59e0b',
  done: '#22c55e',
  archived: '#8b5cf6',
};

export function StageDistributionChart({ data }: Props) {
  const { t } = useTranslation();

  const labelKeys: Record<string, string> = {
    backlog: 'analytics.backlog',
    in_progress: 'analytics.inProgress',
    review: 'analytics.review',
    done: 'analytics.done',
    archived: 'analytics.archived',
  };

  const chartData = Object.entries(data)
    .map(([stage, value]) => ({
      name: t(labelKeys[stage] ?? stage),
      value,
      stage,
    }))
    .filter((item) => item.value > 0);

  if (chartData.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-8 text-sm">
        {t('analytics.noData')}
      </div>
    );
  }

  const total = chartData.reduce((sum, d) => sum + d.value, 0);

  return (
    <div className="flex items-center gap-6">
      <ResponsiveContainer width="50%" height={220}>
        <PieChart>
          <Pie
            data={chartData}
            cx="50%"
            cy="50%"
            innerRadius={55}
            outerRadius={85}
            paddingAngle={2}
            dataKey="value"
            stroke="none"
          >
            {chartData.map((entry) => (
              <Cell
                key={entry.stage}
                fill={COLORS[entry.stage] ?? '#6b7280'}
              />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              backgroundColor: 'hsl(var(--popover))',
              border: '1px solid hsl(var(--border))',
              borderRadius: '6px',
              fontSize: '12px',
              color: 'hsl(var(--popover-foreground))',
            }}
            itemStyle={{ color: 'hsl(var(--popover-foreground))' }}
            labelStyle={{ color: 'hsl(var(--popover-foreground))' }}
          />
        </PieChart>
      </ResponsiveContainer>

      <div className="flex-1 space-y-2">
        {chartData.map((entry) => (
          <div key={entry.stage} className="flex items-center gap-3">
            <div
              className="h-3 w-3 rounded-full flex-shrink-0"
              style={{ backgroundColor: COLORS[entry.stage] }}
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{entry.name}</span>
                <span className="text-sm font-medium ml-2">{entry.value}</span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${(entry.value / total) * 100}%`,
                    backgroundColor: COLORS[entry.stage],
                  }}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
