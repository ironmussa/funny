/**
 * The factory's health (openspec factory-run-detail, D4 and D5): figures over
 * every listed run (the filters do not change them), shown in the view's
 * analytics layout, and a banner for each project whose factory is paused by
 * an incident, shown above every layout.
 */
import { Activity, CheckCircle2, GitMerge, PauseCircle, Timer, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { MetricCard } from '@/components/analytics/MetricCard';
import { ProjectFactoryIncident } from '@/components/general-settings-project/ProjectFactoryIncident';
import { useFactorySettings } from '@/data/factory/hooks';
import type { FactoryQueueRun } from '@/lib/api/factory';
import { formatActionDuration } from '@/lib/github-actions';

import { summarizeFactoryHealth } from './factory-health';

const DASH = '—';

export function FactoryHealthStats({ runs, now }: { runs: FactoryQueueRun[]; now: number }) {
  const { t } = useTranslation();
  if (runs.length === 0) return null;
  const health = summarizeFactoryHealth(runs, now);
  const rate = health.firstPassReviewRate;
  const toMerge = health.medianToMergeMs;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3" data-testid="factory-view-health">
      <MetricCard
        title={t('factoryView.health.inFlight', 'In flight')}
        value={health.inFlight}
        icon={<Activity className="icon-sm" />}
        color="blue"
        valueTestId="factory-view-health-in-flight"
      />
      <MetricCard
        title={t('factoryView.health.needsPerson', 'Need a person')}
        value={health.needsPerson}
        icon={<UserRound className="icon-sm" />}
        color="amber"
        valueTestId="factory-view-health-needs-person"
      />
      <MetricCard
        title={t('factoryView.health.mergedDay', 'Merged, 24 h')}
        value={health.mergedLastDay}
        icon={<GitMerge className="icon-sm" />}
        color="green"
        valueTestId="factory-view-health-merged-day"
      />
      <MetricCard
        title={t('factoryView.health.firstPass', 'First review passed, 7 d')}
        value={rate === null ? DASH : `${Math.round(rate * 100)}%`}
        icon={<CheckCircle2 className="icon-sm" />}
        color="violet"
        valueTestId="factory-view-health-first-pass"
      />
      <MetricCard
        title={t('factoryView.health.mergeHolds', 'Merge holds, 7 d')}
        value={health.mergeHolds}
        icon={<PauseCircle className="icon-sm" />}
        color="red"
        valueTestId="factory-view-health-merge-holds"
      />
      <MetricCard
        title={t('factoryView.health.toMerge', 'Median to merge, 7 d')}
        value={toMerge === null ? DASH : formatActionDuration(toMerge)}
        icon={<Timer className="icon-sm" />}
        color="gray"
        valueTestId="factory-view-health-to-merge"
      />
    </div>
  );
}

function ProjectIncidentBanner({ projectId }: { projectId: string }) {
  const settings = useFactorySettings(projectId);
  if (!settings?.incident) return null;
  return (
    <ProjectFactoryIncident
      projectId={projectId}
      incident={settings.incident}
      testIdPrefix={`factory-view-incident-${projectId}`}
    />
  );
}

/** One banner per project with listed runs whose factory has an open incident. */
export function FactoryIncidentBanners({ runs }: { runs: FactoryQueueRun[] }) {
  const projectIds = [...new Set(runs.map((run) => run.projectId))];
  return (
    <>
      {projectIds.map((projectId) => (
        <ProjectIncidentBanner key={projectId} projectId={projectId} />
      ))}
    </>
  );
}
