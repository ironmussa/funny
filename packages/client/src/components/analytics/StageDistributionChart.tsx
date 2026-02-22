import { useTranslation } from 'react-i18next';
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from 'recharts';

interface Props {
  data: Record<string, number>;
}

const COLORS: Record<string, string> = {
  backlog: '#6b7280',
  planning: '#a78bfa',
  in_progress: '#3b82f6',
  review: '#f59e0b',
  done: '#22c55e',
  archived: '#8b5cf6',
};

// Hoisted tooltip styles to avoid re-creating objects on every render (rerender-memo-with-default-value)
const TOOLTIP_CONTENT_STYLE: React.CSSProperties = {
  backgroundColor: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border))',
  borderRadius: '6px',
  fontSize: '12px',
  color: 'hsl(var(--popover-foreground))',
};
const TOOLTIP_ITEM_STYLE: React.CSSProperties = { color: 'hsl(var(--popover-foreground))' };
const TOOLTIP_LABEL_STYLE: React.CSSProperties = { color: 'hsl(var(--popover-foreground))' };

const LABEL_KEYS: Record<string, string> = {
  backlog: 'analytics.backlog',
  planning: 'analytics.planning',
  in_progress: 'analytics.inProgress',
  review: 'analytics.review',
  done: 'analytics.done',
  archived: 'analytics.archived',
};

export function StageDistributionChart({ data }: Props) {
  const { t } = useTranslation();

  const chartData = Object.entries(data)
    .map(([stage, value]) => ({
      name: t(LABEL_KEYS[stage] ?? stage),
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
            contentStyle={TOOLTIP_CONTENT_STYLE}
            itemStyle={TOOLTIP_ITEM_STYLE}
            labelStyle={TOOLTIP_LABEL_STYLE}
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
