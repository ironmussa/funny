/**
 * How the factory's integration went over the runs the view shows (its
 * filters apply, so one project can be read on its own): outcomes, time in the
 * queue and to merge, and what integrating cost (CI rounds, red checks,
 * conflicts, agent fixes, merge queue batches). Folded by default under the
 * view's header; computed from the listed runs (`summarizeFactoryRuns`), so it
 * needs no request of its own.
 */
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { FACTORY_METRICS_WINDOW_DAYS, summarizeFactoryRuns } from '@/data/factory/metrics';
import type { FactoryRun } from '@/lib/api/factory';
import { formatActionDuration } from '@/lib/github-actions';
import { cn } from '@/lib/utils';

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

export function FactoryIntegrationStats({
  runs,
  now,
}: {
  runs: readonly FactoryRun[];
  now: number;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const summary = summarizeFactoryRuns(runs, { now });
  if (summary.runs === 0) return null;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="border-border/50 border-b px-4 py-2"
      data-testid="factory-metrics"
    >
      <CollapsibleTrigger
        className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs font-medium"
        data-testid="factory-metrics-toggle"
      >
        <ChevronRight className={cn('icon-xs transition-transform', open && 'rotate-90')} />
        {t('factory.metrics.title', 'Integration, last {{days}} days', {
          days: FACTORY_METRICS_WINDOW_DAYS,
        })}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid grid-cols-2 gap-2 pt-2 sm:grid-cols-4 xl:grid-cols-6">
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
          <Stat
            id="settled-without-agent"
            label={t('factory.metrics.settledWithoutAgent', 'Conflicts settled with no agent')}
            value={percent(summary.settledWithoutAgentRate)}
          />
          <Stat
            id="batch-size"
            label={t('factory.metrics.batchSize', 'Pull requests per batch')}
            value={decimal(summary.avgBatchSize)}
          />
          <Stat
            id="batch-wait"
            label={t('factory.metrics.batchWait', 'Median time in the merge queue')}
            value={duration(summary.medianBatchWaitMs)}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
