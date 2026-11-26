/**
 * The lanes of the caller's issue factory (openspec factory-lanes):
 * the label and branch prefixes (fixed while lanes exist), and the list of
 * lanes with their label, branch, state, open runs, sync state/PR/error, CI
 * warning, and actions (sync/retry, finish lane, remove).
 */
import type { FactoryLane, FactoryLaneSyncState } from '@funny/shared/contracts/factory';
import { ExternalLink, GitMerge, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { BranchBadge } from '@/components/BranchBadge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LabelBadge, type LabelBadgeTone } from '@/components/ui/label-badge';
import { finishFactoryLane, removeFactoryLane, syncFactoryLane } from '@/data/factory/actions';
import { useFactoryLanes } from '@/data/factory/hooks';
import type { SaveFactorySettingsInput } from '@/lib/api/factory';
import { toastError } from '@/lib/toast-error';

import { ProjectSettingRow } from './setting-primitives';

const SYNC_TONE: Record<FactoryLaneSyncState, LabelBadgeTone> = {
  idle: 'neutral',
  merging: 'info',
  resolving: 'warning',
  checking: 'info',
  needs_human: 'danger',
};

const SYNC_IN_FLIGHT = new Set<FactoryLaneSyncState>(['merging', 'resolving', 'checking']);

function syncLabel(state: FactoryLaneSyncState, t: ReturnType<typeof useTranslation>['t']): string {
  switch (state) {
    case 'idle':
      return t('settings.projectFactoryLaneSyncIdle', 'Idle');
    case 'merging':
      return t('settings.projectFactoryLaneSyncMerging', 'Syncing');
    case 'resolving':
      return t('settings.projectFactoryLaneSyncResolving', 'Resolving conflicts');
    case 'checking':
      return t('settings.projectFactoryLaneSyncChecking', 'Checking CI');
    case 'needs_human':
      return t('settings.projectFactoryLaneSyncNeedsHuman', 'Sync needs attention');
  }
}

function LaneRow({ projectId, lane }: { projectId: string; lane: FactoryLane }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<'sync' | 'finish' | 'remove' | null>(null);
  const inFlight = SYNC_IN_FLIGHT.has(lane.syncState);
  const hasOpenRuns = lane.openRuns.length > 0;
  const canSync = lane.state === 'active' && !inFlight;
  const canFinish = lane.state === 'active' && !hasOpenRuns;
  const canRemove = !hasOpenRuns && !inFlight;

  const sync = () => {
    setBusy('sync');
    void syncFactoryLane(projectId, lane.name)
      .map((result) => {
        if (result.outcome === 'in-flight') {
          toast.info(
            t(
              'settings.projectFactoryLaneSyncInFlight',
              'Sync already in progress for lane {{name}}',
              { name: lane.name },
            ),
          );
        } else {
          toast.success(
            t('settings.projectFactoryLaneSyncRequested', 'Sync started for lane {{name}}', {
              name: lane.name,
            }),
          );
        }
      })
      .orTee((error) => toastError(error, 'factory'))
      .match(
        () => setBusy(null),
        () => setBusy(null),
      );
  };

  const finish = () => {
    setBusy('finish');
    void finishFactoryLane(projectId, lane.name)
      .map((result) => {
        toast.success(
          t(
            'settings.projectFactoryLaneFinished',
            'Opened finish PR #{{number}} for lane {{name}}',
            { number: result.prNumber, name: lane.name },
          ),
        );
      })
      .orTee((error) => toastError(error, 'factory'))
      .match(
        () => setBusy(null),
        () => setBusy(null),
      );
  };

  const remove = () => {
    setBusy('remove');
    void removeFactoryLane(projectId, lane.name)
      .orTee((error) => toastError(error, 'factory'))
      .match(
        () => setBusy(null),
        () => setBusy(null),
      );
  };

  return (
    <li
      className="border-border/50 flex flex-col gap-1.5 border-b px-4 py-2.5 text-xs last:border-b-0"
      data-testid={`settings-factory-lane-${lane.name}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <LabelBadge tone="info" data-testid={`settings-factory-lane-label-${lane.name}`}>
          {lane.label}
        </LabelBadge>
        <BranchBadge
          branch={lane.branch}
          size="xs"
          data-testid={`settings-factory-lane-branch-${lane.name}`}
        />
        <LabelBadge
          tone={lane.state === 'active' ? 'success' : 'neutral'}
          data-testid={`settings-factory-lane-state-${lane.name}`}
        >
          {lane.state === 'active'
            ? t('settings.projectFactoryLaneStateActive', 'Active')
            : t('settings.projectFactoryLaneStateFinished', 'Finished')}
        </LabelBadge>
        <LabelBadge
          tone={SYNC_TONE[lane.syncState]}
          data-testid={`settings-factory-lane-sync-state-${lane.name}`}
        >
          {syncLabel(lane.syncState, t)}
        </LabelBadge>

        {lane.syncPrNumber && lane.syncPrUrl && (
          <a
            href={lane.syncPrUrl}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 font-mono hover:underline"
            data-testid={`settings-factory-lane-sync-pr-${lane.name}`}
          >
            {t('settings.projectFactoryLaneSyncPr', 'Sync PR #{{number}}', {
              number: lane.syncPrNumber,
            })}
            <ExternalLink className="icon-xs" />
          </a>
        )}

        {lane.finishPrNumber && lane.finishPrUrl && (
          <a
            href={lane.finishPrUrl}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 font-mono hover:underline"
            data-testid={`settings-factory-lane-finish-pr-${lane.name}`}
          >
            {t('settings.projectFactoryLaneFinishPr', 'Finish PR #{{number}}', {
              number: lane.finishPrNumber,
            })}
            <ExternalLink className="icon-xs" />
          </a>
        )}

        <div className="ml-auto flex items-center gap-1">
          {canSync && (
            <Button
              variant="outline"
              size="xs"
              disabled={busy !== null}
              onClick={sync}
              data-testid={`settings-factory-lane-sync-${lane.name}`}
            >
              <RefreshCw className="icon-xs" />
              {lane.syncState === 'needs_human'
                ? t('settings.projectFactoryLaneSyncRetry', 'Retry sync')
                : t('settings.projectFactoryLaneSyncNow', 'Sync now')}
            </Button>
          )}
          {lane.state === 'active' && (
            <Button
              variant="outline"
              size="xs"
              disabled={busy !== null || !canFinish}
              onClick={finish}
              data-testid={`settings-factory-lane-finish-${lane.name}`}
            >
              <GitMerge className="icon-xs" />
              {t('settings.projectFactoryLaneFinish', 'Finish lane')}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={busy !== null || !canRemove}
            onClick={remove}
            aria-label={t('settings.projectFactoryLaneRemove', 'Remove lane')}
            data-testid={`settings-factory-lane-remove-${lane.name}`}
          >
            <Trash2 className="icon-sm" />
          </Button>
        </div>
      </div>

      {hasOpenRuns && (
        <p
          className="text-muted-foreground"
          data-testid={`settings-factory-lane-open-runs-${lane.name}`}
        >
          {t('settings.projectFactoryLaneOpenRuns', 'Open runs: {{runs}}', {
            runs: lane.openRuns.join(', '),
          })}
        </p>
      )}

      {lane.syncError && (
        <p
          className="text-destructive"
          data-testid={`settings-factory-lane-sync-error-${lane.name}`}
        >
          {lane.syncError}
        </p>
      )}

      {lane.ciWarning && (
        <p
          className="text-status-warning"
          data-testid={`settings-factory-lane-ci-warning-${lane.name}`}
        >
          {lane.ciWarning}
        </p>
      )}

      <LaneConflicts lane={lane} />
    </li>
  );
}

/** The other lanes this one's branch conflicts with, from the daily check (openspec factory-lanes D7). */
function LaneConflicts({ lane }: { lane: FactoryLane }) {
  const { t } = useTranslation();
  return (
    <>
      {lane.conflicts?.map((conflict) => (
        <p
          key={conflict.lane}
          className="text-status-warning"
          data-testid={`settings-factory-lane-conflict-${lane.name}-${conflict.lane}`}
        >
          {t('settings.projectFactoryLaneConflict', 'Conflicts with {{lane}} on {{paths}}', {
            lane: conflict.lane,
            paths: conflict.paths.join(', '),
          })}
        </p>
      ))}
      {lane.conflictsNote && (
        <p
          className="text-muted-foreground"
          data-testid={`settings-factory-lane-conflict-note-${lane.name}`}
        >
          {t('settings.projectFactoryLaneConflictNote', 'Conflict check: {{note}}', {
            note: lane.conflictsNote,
          })}
        </p>
      )}
    </>
  );
}

export function ProjectFactoryLanes({
  projectId,
  label,
  laneLabelPrefix,
  laneBranchPrefix,
  rowKey,
  onSave,
}: {
  projectId: string;
  label: string;
  laneLabelPrefix: string;
  laneBranchPrefix: string;
  rowKey: string;
  onSave: (input: Pick<SaveFactorySettingsInput, 'laneLabelPrefix' | 'laneBranchPrefix'>) => void;
}) {
  const { t } = useTranslation();
  const lanes = useFactoryLanes(projectId);
  const hasLanes = (lanes?.length ?? 0) > 0;

  return (
    <>
      <ProjectSettingRow
        settingId="factory.laneLabelPrefix"
        title={t('settings.projectFactoryLaneLabelPrefix', 'Lane label prefix')}
        description={t(
          'settings.projectFactoryLaneLabelPrefixDesc',
          'An issue needs both the factory label ({{label}}) and a {{prefix}}<name> label to run in a lane. Fixed while lanes exist',
          { label, prefix: laneLabelPrefix },
        )}
      >
        <Input
          key={`lane-label-prefix-${rowKey}`}
          defaultValue={laneLabelPrefix}
          disabled={hasLanes}
          className="w-[220px]"
          data-testid="settings-factory-lane-label-prefix"
          onBlur={(e) => {
            const next = e.target.value.trim();
            if (next && next !== laneLabelPrefix) onSave({ laneLabelPrefix: next });
          }}
        />
      </ProjectSettingRow>

      <ProjectSettingRow
        settingId="factory.laneBranchPrefix"
        title={t('settings.projectFactoryLaneBranchPrefix', 'Lane branch prefix')}
        description={t(
          'settings.projectFactoryLaneBranchPrefixDesc',
          'Prefix for lane branches created from Merge into ({{prefix}}<name>). Fixed while lanes exist',
          { prefix: laneBranchPrefix },
        )}
      >
        <Input
          key={`lane-branch-prefix-${rowKey}`}
          defaultValue={laneBranchPrefix}
          disabled={hasLanes}
          className="w-[220px]"
          data-testid="settings-factory-lane-branch-prefix"
          onBlur={(e) => {
            const next = e.target.value.trim();
            if (next && next !== laneBranchPrefix) onSave({ laneBranchPrefix: next });
          }}
        />
      </ProjectSettingRow>

      <ProjectSettingRow
        settingId="factory.lanes"
        title={t('settings.projectFactoryLanes', 'Lanes')}
        description={t(
          'settings.projectFactoryLanesDesc',
          'Parallel feature branches created from Merge into. An issue needs the factory label ({{label}}) and a {{prefix}}<name> label to join a lane',
          { label, prefix: laneLabelPrefix },
        )}
      >
        <span className="text-muted-foreground text-xs" data-testid="settings-factory-lanes-count">
          {lanes?.length ?? 0}
        </span>
      </ProjectSettingRow>

      {lanes && lanes.length > 0 && (
        <ul data-testid="settings-factory-lanes">
          {lanes.map((lane) => (
            <LaneRow key={lane.id} projectId={projectId} lane={lane} />
          ))}
        </ul>
      )}
    </>
  );
}
