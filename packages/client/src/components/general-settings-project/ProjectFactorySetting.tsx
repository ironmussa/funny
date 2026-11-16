/**
 * The issue factory for a project (change issue-factory): a per-user toggle plus
 * the watched issue label, the flow to run, and how many issues run at once.
 * Every contributor configures their own; a viewer sees theirs but a save is
 * refused (403) and shown as an error.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Input } from '@/components/ui/input';
import { saveFactorySettings } from '@/data/factory/actions';
import { useFactorySettings } from '@/data/factory/hooks';
import type { SaveFactorySettingsInput } from '@/lib/api/factory';
import { toastError } from '@/lib/toast-error';

import { SegmentedControl, SettingRow } from './setting-primitives';

type OnOff = 'on' | 'off';

export function ProjectFactorySetting({ projectId }: { projectId: string }) {
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

  const enabled = settings?.enabled ?? false;
  const label = settings?.label ?? 'ready-for-agent';
  const flowName = settings?.flowName ?? 'issue-to-merge';
  const maxConcurrent = settings?.maxConcurrent ?? 2;
  const rowKey = `${settings?.updatedAt ?? 'none'}-${revision}`;

  const setEnabled = (value: OnOff) => void save({ enabled: value === 'on' });
  const setLabel = (value: string) => {
    const next = value.trim();
    if (next && next !== label) void save({ enabled, label: next });
  };
  const setFlow = (value: string) => {
    const next = value.trim();
    if (next && next !== flowName) void save({ enabled, flowName: next });
  };
  const setConcurrency = (value: string) => {
    const next = Number.parseInt(value, 10);
    if (Number.isFinite(next) && next >= 1 && next <= 20 && next !== maxConcurrent) {
      void save({ enabled, maxConcurrent: next });
    }
  };

  return (
    <>
      <SettingRow
        title={t('settings.projectFactory', 'Issue factory')}
        description={t(
          'settings.projectFactoryDesc',
          'Watch this repo for labelled issues and run a flow to PR',
        )}
      >
        <SegmentedControl<OnOff>
          value={enabled ? 'on' : 'off'}
          onChange={setEnabled}
          options={[
            { value: 'off', label: t('common.off', 'Off'), testId: 'settings-factory-off' },
            { value: 'on', label: t('common.on', 'On'), testId: 'settings-factory-on' },
          ]}
        />
      </SettingRow>

      {enabled && (
        <>
          <SettingRow
            title={t('settings.projectFactoryLabel', 'Issue label')}
            description={t(
              'settings.projectFactoryLabelDesc',
              'Issues with this label are picked up',
            )}
          >
            <Input
              key={`label-${rowKey}`}
              defaultValue={label}
              className="w-[220px]"
              data-testid="settings-factory-label"
              onBlur={(e) => setLabel(e.target.value)}
            />
          </SettingRow>

          <SettingRow
            title={t('settings.projectFactoryFlow', 'Flow')}
            description={t('settings.projectFactoryFlowDesc', 'Workflow file run for each issue')}
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
    </>
  );
}
