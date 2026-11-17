/**
 * The issue factory for a project (change issue-factory): a per-user running /
 * paused toggle, the mode (manual: only the issues sent from the Issues tab;
 * automatic: also the issues carrying the label, change factory-manual-queue),
 * the default flow, and how many issues run at once.
 * Every contributor configures their own; a viewer sees theirs but a save is
 * refused (403) and shown as an error.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { saveFactorySettings } from '@/data/factory/actions';
import { useFactorySettings } from '@/data/factory/hooks';
import { useCanSteerProject } from '@/data/projects/hooks';
import type { FactoryMode, FactorySettings, SaveFactorySettingsInput } from '@/lib/api/factory';
import { toastError } from '@/lib/toast-error';

import { ProjectFactoryRuns } from './ProjectFactoryRuns';
import { SegmentedControl, SettingRow } from './setting-primitives';

type OnOff = 'on' | 'off';

/** The server's defaults: what the form shows before the first save. */
const DEFAULT_FORM = {
  enabled: false,
  mode: 'manual' as FactoryMode,
  label: 'ready-for-agent',
  flowName: 'issue-to-merge',
  maxConcurrent: 2,
};

/** What the form shows: the saved settings, or the defaults before the first save. */
function formValues(settings: FactorySettings | null | undefined) {
  if (!settings) return DEFAULT_FORM;
  const { enabled, mode, label, flowName, maxConcurrent } = settings;
  return { enabled, mode, label, flowName, maxConcurrent };
}

/** The trimmed text when it is non-empty and differs from `current`, else null (nothing to save). */
function changedText(value: string, current: string): string | null {
  const next = value.trim();
  return next && next !== current ? next : null;
}

/** A concurrency within 1–20 that differs from `current`, else null. */
function changedConcurrency(value: string, current: number): number | null {
  const next = Number.parseInt(value, 10);
  const inRange = Number.isFinite(next) && next >= 1 && next <= 20;
  return inRange && next !== current ? next : null;
}

/** The mode, and the label that automatic mode picks up. */
function FactoryModeRows({
  mode,
  label,
  labelKey,
  onMode,
  onLabel,
}: {
  mode: FactoryMode;
  label: string;
  labelKey: string;
  onMode: (mode: FactoryMode) => void;
  onLabel: (label: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <SettingRow
        title={t('settings.projectFactoryMode', 'Mode')}
        description={
          mode === 'automatic'
            ? t(
                'settings.projectFactoryModeAutomaticDesc',
                'Also picks up the issues carrying the label, after the ones you send',
              )
            : t('settings.projectFactoryModeManualDesc', 'Only the issues you send')
        }
      >
        <SegmentedControl<FactoryMode>
          value={mode}
          onChange={onMode}
          options={[
            {
              value: 'manual',
              label: t('settings.projectFactoryManual', 'Manual'),
              testId: 'settings-factory-mode-manual',
            },
            {
              value: 'automatic',
              label: t('settings.projectFactoryAutomatic', 'Automatic'),
              testId: 'settings-factory-mode-automatic',
            },
          ]}
        />
      </SettingRow>

      {mode === 'automatic' && (
        <SettingRow
          title={t('settings.projectFactoryLabel', 'Issue label')}
          description={t(
            'settings.projectFactoryLabelDesc',
            'Issues with this label are picked up',
          )}
        >
          <Input
            key={labelKey}
            defaultValue={label}
            className="w-[220px]"
            data-testid="settings-factory-label"
            onBlur={(e) => onLabel(e.target.value)}
          />
        </SettingRow>
      )}
    </>
  );
}

function ProjectFactorySettingRows({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const settings = useFactorySettings(projectId);
  // Bumped after every save settles, so the inputs re-read the confirmed row —
  // also after a refused save, which leaves the row (and its updatedAt) unchanged.
  const [revision, setRevision] = useState(0);

  const save = (input: Omit<SaveFactorySettingsInput, 'projectId'>) =>
    saveFactorySettings({ projectId, ...input })
      .orTee((error) => toastError(error))
      .match(
        () => setRevision((r) => r + 1),
        () => setRevision((r) => r + 1),
      );

  const { enabled, mode, label, flowName, maxConcurrent } = formValues(settings);
  const rowKey = `${settings?.updatedAt ?? 'none'}-${revision}`;

  const setEnabled = (value: OnOff) => void save({ enabled: value === 'on' });
  const setMode = (value: FactoryMode) => void save({ enabled, mode: value });
  const setLabel = (value: string) => {
    const next = changedText(value, label);
    if (next) void save({ enabled, label: next });
  };
  const setFlow = (value: string) => {
    const next = changedText(value, flowName);
    if (next) void save({ enabled, flowName: next });
  };
  const setConcurrency = (value: string) => {
    const next = changedConcurrency(value, maxConcurrent);
    if (next !== null) void save({ enabled, maxConcurrent: next });
  };

  return (
    <>
      <SettingRow
        title={t('settings.projectFactory', 'Issue factory')}
        description={t(
          'settings.projectFactoryDesc',
          'Run a flow to PR for the issues you send from the Issues tab. Paused: nothing new starts',
        )}
      >
        <SegmentedControl<OnOff>
          value={enabled ? 'on' : 'off'}
          onChange={setEnabled}
          options={[
            {
              value: 'off',
              label: t('settings.projectFactoryPaused', 'Paused'),
              testId: 'settings-factory-off',
            },
            {
              value: 'on',
              label: t('settings.projectFactoryRunning', 'Running'),
              testId: 'settings-factory-on',
            },
          ]}
        />
      </SettingRow>

      {enabled && (
        <>
          <FactoryModeRows
            mode={mode}
            label={label}
            labelKey={`label-${rowKey}`}
            onMode={setMode}
            onLabel={setLabel}
          />

          <SettingRow
            title={t('settings.projectFactoryFlow', 'Flow')}
            description={t(
              'settings.projectFactoryFlowDesc',
              'The default flow: preselected when you send issues, and run for labelled ones',
            )}
          >
            <Input
              key={`flow-${rowKey}`}
              defaultValue={flowName}
              className="w-[220px]"
              data-testid="settings-factory-flow"
              onBlur={(e) => setFlow(e.target.value)}
            />
          </SettingRow>

          <SettingRow
            title={t('settings.projectFactoryConcurrency', 'Max in flight')}
            description={t('settings.projectFactoryConcurrencyDesc', 'How many issues run at once')}
          >
            <Input
              key={`conc-${rowKey}`}
              type="number"
              min={1}
              max={20}
              defaultValue={maxConcurrent}
              className="w-[220px]"
              data-testid="settings-factory-concurrency"
              onBlur={(e) => setConcurrency(e.target.value)}
            />
          </SettingRow>
        </>
      )}

      {settings?.blockedReason && (
        <Alert
          variant="destructive"
          className="mx-4 my-2 w-auto"
          data-testid="settings-factory-blocked"
        >
          <AlertDescription>{settings.blockedReason}</AlertDescription>
        </Alert>
      )}

      {/* A paused factory still finishes its runs in flight: they stay listed. */}
      {settings && <ProjectFactoryRuns projectId={projectId} />}
    </>
  );
}

/** Hidden from a viewer: the setting is per-user and only matters to whoever may start threads. */
export function ProjectFactorySetting({ projectId }: { projectId: string }) {
  const canSteer = useCanSteerProject(projectId);
  return canSteer ? <ProjectFactorySettingRows projectId={projectId} /> : null;
}
