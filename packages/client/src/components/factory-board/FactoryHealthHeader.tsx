/**
 * The factory view's health (openspec factory-run-detail, D4 and D5): a row of
 * figures over every listed run (the filters do not change them), and a banner
 * for each project whose factory is paused by an incident.
 */
import { useTranslation } from 'react-i18next';

import { ProjectFactoryIncident } from '@/components/general-settings-project/ProjectFactoryIncident';
import { useFactorySettings } from '@/data/factory/hooks';
import type { FactoryQueueRun } from '@/lib/api/factory';
import { formatActionDuration } from '@/lib/github-actions';

import { summarizeFactoryHealth } from './factory-health';

function Stat({ id, label, value }: { id: string; label: string; value: string }) {
  return (
    <div className="flex flex-col" data-testid={`factory-view-health-${id}`}>
      <span className="text-muted-foreground text-2xs truncate">{label}</span>
      <span className="text-sm font-medium tabular-nums">{value}</span>
    </div>
  );
}

const DASH = '—';

export function FactoryHealthStats({ runs, now }: { runs: FactoryQueueRun[]; now: number }) {
  const { t } = useTranslation();
  if (runs.length === 0) return null;
  const health = summarizeFactoryHealth(runs, now);
  const rate = health.firstPassReviewRate;
  const toMerge = health.medianToMergeMs;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1" data-testid="factory-view-health">
      <Stat
        id="in-flight"
        label={t('factoryView.health.inFlight', 'In flight')}
        value={String(health.inFlight)}
      />
      <Stat
        id="needs-person"
        label={t('factoryView.health.needsPerson', 'Need a person')}
        value={String(health.needsPerson)}
      />
      <Stat
        id="merged-day"
        label={t('factoryView.health.mergedDay', 'Merged, 24 h')}
        value={String(health.mergedLastDay)}
      />
      <Stat
        id="first-pass"
        label={t('factoryView.health.firstPass', 'First review passed, 7 d')}
        value={rate === null ? DASH : `${Math.round(rate * 100)}%`}
      />
      <Stat
        id="merge-holds"
        label={t('factoryView.health.mergeHolds', 'Merge holds, 7 d')}
        value={String(health.mergeHolds)}
      />
      <Stat
        id="to-merge"
        label={t('factoryView.health.toMerge', 'Median to merge, 7 d')}
        value={toMerge === null ? DASH : formatActionDuration(toMerge)}
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
