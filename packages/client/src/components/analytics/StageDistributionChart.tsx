import { useTranslation } from 'react-i18next';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';

import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/utils';

interface Props {
  data: Record<string, number>;
}

const COLORS = new Map(
  Object.entries({
    backlog: '#6b7280',
    planning: '#a78bfa',
    in_progress: '#3b82f6',
    review: '#f59e0b',
    done: '#22c55e',
    archived: '#8b5cf6',
  }),
);

/** Legend class per stage: the COLORS values, as theme tokens in globals.css. */
const LEGEND_BG = new Map([
  ['backlog', 'bg-stage-backlog'],
  ['planning', 'bg-stage-planning'],
  ['in_progress', 'bg-stage-in-progress'],
  ['review', 'bg-stage-review'],
  ['done', 'bg-stage-done'],
  ['archived', 'bg-stage-archived'],
]);

// Hoisted tooltip styles to avoid re-creating objects on every render (rerender-memo-with-default-value)
const TOOLTIP_CONTENT_STYLE: React.CSSProperties = {
  backgroundColor: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border))',
  borderRadius: '6px',
  fontSize: '0.75rem',
  color: 'hsl(var(--popover-foreground))',
};
const TOOLTIP_ITEM_STYLE: React.CSSProperties = { color: 'hsl(var(--popover-foreground))' };
const TOOLTIP_LABEL_STYLE: React.CSSProperties = { color: 'hsl(var(--popover-foreground))' };

const LABEL_KEYS = new Map(
  Object.entries({
    backlog: 'analytics.backlog',
    planning: 'analytics.planning',
    in_progress: 'analytics.inProgress',
    review: 'analytics.review',
    done: 'analytics.done',
    archived: 'analytics.archived',
  }),
);

export function StageDistributionChart({ data }: Props) {
  const { t } = useTranslation();

  const chartData = Object.entries(data).flatMap(([stage, value]) =>
    value > 0 ? [{ name: t(LABEL_KEYS.get(stage) ?? stage), value, stage }] : [],
  );

  if (chartData.length === 0) {
    return <EmptyState padding="md" fill={false} title={t('analytics.noData')} />;
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
              <Cell key={entry.stage} fill={COLORS.get(entry.stage) ?? '#6b7280'} />
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
          <div
            key={entry.stage}
            className="flex items-center gap-3"
            style={{ '--stage-share': `${(entry.value / total) * 100}%` }}
          >
            <div className={cn('size-3 shrink-0 rounded-full', LEGEND_BG.get(entry.stage))} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground text-xs">{entry.name}</span>
                <span className="ml-2 text-sm font-medium">{entry.value}</span>
              </div>
              <div className="bg-muted mt-1 h-1.5 overflow-hidden rounded-full">
                <div
                  className={cn(
                    'h-full w-[var(--stage-share)] rounded-full transition-[width,background-color]',
                    LEGEND_BG.get(entry.stage),
                  )}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
