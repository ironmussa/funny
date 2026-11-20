/**
 * How the factory's integration went over the last 30 days: outcomes, time in
 * the queue and to merge, and what integrating cost (CI rounds, red checks,
 * conflicts, agent fixes). The numbers come from the runs already loaded for
 * the runs list (`summarizeFactoryRuns`), so they need no request of their own.
 */
import { useTranslation } from 'react-i18next';

import { useFactoryRuns } from '@/data/factory/hooks';
import { DEFAULT_METRICS_WINDOW_DAYS, summarizeFactoryRuns } from '@/data/factory/metrics';
import { formatActionDuration } from '@/lib/github-actions';

const percent = (value: number | null) => (value === null ? '—' : `${Math.round(value * 100)}%`);
const decimal = (value: number | null) => (value === null ? '—' : value.toFixed(1));
const duration = (ms: number | null) => (ms === null ? '—' : formatActionDuration(ms));

function Stat({ id, label, value }: { id: string; label: string; value: string }) {
  return (
    <div className="bg-muted/40 flex flex-col gap-0.5 rounded-md px-2.5 py-1.5">
      <span className="text-muted-foreground truncate text-xs">{label}</span>
      <span className="text-sm font-medium tabular-nums" data-testid={`factory-metric-${id}`}>
        {value}
      </span>
    </div>
  );
}

export function ProjectFactoryMetrics({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const runs = useFactoryRuns(projectId);
  if (!runs?.length) return null;
  const summary = summarizeFactoryRuns(runs);
  if (summary.runs === 0) return null;

  return (
    <div className="px-4 py-3" data-testid="factory-metrics">
      <div className="mb-2 text-sm font-medium">
        {t('factory.metrics.title', 'Integration, last {{days}} days', {
          days: DEFAULT_METRICS_WINDOW_DAYS,
        })}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat id="runs" label={t('factory.metrics.runs', 'Runs')} value={String(summary.runs)} />
        <Stat
          id="merge-rate"
          label={t('factory.metrics.mergeRate', 'Merged')}
          value={percent(summary.mergeRate)}
        />
        <Stat
          id="queue-time"
          label={t('factory.metrics.medianQueue', 'Median time in queue')}
          value={duration(summary.medianQueueMs)}
        />
        <Stat
          id="time-to-merge"
          label={t('factory.metrics.medianToMerge', 'Median time to merge')}
          value={duration(summary.medianToMergeMs)}
        />
        <Stat
          id="ci-rounds"
          label={t('factory.metrics.ciRounds', 'CI rounds per run')}
          value={decimal(summary.avgCiRounds)}
        />
        <Stat
          id="red-rate"
          label={t('factory.metrics.redRate', 'Red CI rounds')}
          value={percent(summary.redRate)}
        />
        <Stat
          id="conflict-rate"
          label={t('factory.metrics.conflictRate', 'Runs with a conflict')}
          value={percent(summary.conflictRate)}
        />
        <Stat
          id="agent-fixes"
          label={t('factory.metrics.agentFixes', 'Agent fixes per run')}
          value={decimal(summary.avgAgentFixes)}
        />
      </div>
    </div>
  );
}
