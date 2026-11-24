/**
 * How the factory's integration went over the runs the view shows (its
 * filters apply, so one project can be read on its own): outcomes, time in the
 * queue and to merge, and what integrating cost (CI rounds, red checks,
 * conflicts, agent fixes, merge queue batches). Shown in the view's analytics
 * layout; computed from the listed runs (`summarizeFactoryRuns`), so it needs
 * no request of its own.
 */
import {
  AlertTriangle,
  GitMerge,
  Hourglass,
  Layers,
  ListChecks,
  RefreshCw,
  Sparkles,
  Timer,
  Wrench,
  XCircle,
  Clock,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { MetricCard } from '@/components/analytics/MetricCard';
import { summarizeFactoryRuns } from '@/data/factory/metrics';
import type { FactoryRun } from '@/lib/api/factory';
import { formatActionDuration } from '@/lib/github-actions';

const percent = (value: number | null) => (value === null ? '—' : `${Math.round(value * 100)}%`);
const decimal = (value: number | null) => (value === null ? '—' : value.toFixed(1));
const duration = (ms: number | null) => (ms === null ? '—' : formatActionDuration(ms));

interface Figure {
  id: string;
  title: string;
  value: string;
  icon: ReactNode;
  color: 'blue' | 'green' | 'amber' | 'gray' | 'violet' | 'red';
}

export function FactoryIntegrationStats({
  runs,
  now,
}: {
  runs: readonly FactoryRun[];
  now: number;
}) {
  const { t } = useTranslation();
  const summary = summarizeFactoryRuns(runs, { now });
  if (summary.runs === 0) return null;

  const figures: Figure[] = [
    {
      id: 'runs',
      title: t('factory.metrics.runs', 'Runs'),
      value: String(summary.runs),
      icon: <ListChecks className="icon-sm" />,
      color: 'blue',
    },
    {
      id: 'merge-rate',
      title: t('factory.metrics.mergeRate', 'Merged'),
      value: percent(summary.mergeRate),
      icon: <GitMerge className="icon-sm" />,
      color: 'green',
    },
    {
      id: 'queue-time',
      title: t('factory.metrics.medianQueue', 'Median time in queue'),
      value: duration(summary.medianQueueMs),
      icon: <Hourglass className="icon-sm" />,
      color: 'gray',
    },
    {
      id: 'time-to-merge',
      title: t('factory.metrics.medianToMerge', 'Median time to merge'),
      value: duration(summary.medianToMergeMs),
      icon: <Timer className="icon-sm" />,
      color: 'gray',
    },
    {
      id: 'ci-rounds',
      title: t('factory.metrics.ciRounds', 'CI rounds per run'),
      value: decimal(summary.avgCiRounds),
      icon: <RefreshCw className="icon-sm" />,
      color: 'blue',
    },
    {
      id: 'red-rate',
      title: t('factory.metrics.redRate', 'Red CI rounds'),
      value: percent(summary.redRate),
      icon: <XCircle className="icon-sm" />,
      color: 'red',
    },
    {
      id: 'conflict-rate',
      title: t('factory.metrics.conflictRate', 'Runs with a conflict'),
      value: percent(summary.conflictRate),
      icon: <AlertTriangle className="icon-sm" />,
      color: 'amber',
    },
    {
      id: 'agent-fixes',
      title: t('factory.metrics.agentFixes', 'Agent fixes per run'),
      value: decimal(summary.avgAgentFixes),
      icon: <Wrench className="icon-sm" />,
      color: 'violet',
    },
    {
      id: 'settled-without-agent',
      title: t('factory.metrics.settledWithoutAgent', 'Conflicts settled with no agent'),
      value: percent(summary.settledWithoutAgentRate),
      icon: <Sparkles className="icon-sm" />,
      color: 'green',
    },
    {
      id: 'batch-size',
      title: t('factory.metrics.batchSize', 'Pull requests per batch'),
      value: decimal(summary.avgBatchSize),
      icon: <Layers className="icon-sm" />,
      color: 'blue',
    },
    {
      id: 'batch-wait',
      title: t('factory.metrics.batchWait', 'Median time in the merge queue'),
      value: duration(summary.medianBatchWaitMs),
      icon: <Clock className="icon-sm" />,
      color: 'gray',
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3" data-testid="factory-metrics">
      {figures.map((figure) => (
        <MetricCard
          key={figure.id}
          title={figure.title}
          value={figure.value}
          icon={figure.icon}
          color={figure.color}
          valueTestId={`factory-metric-${figure.id}`}
        />
      ))}
    </div>
  );
}
