/**
 * Whether Claude agents in the project run checks (tests, type checks,
 * linters) through funny's `funny_run_checks` tool instead of raw Bash, so
 * their progress shows in the thread. On unless the project turned it off.
 */
import type { Project } from '@funny/shared';
import { useTranslation } from 'react-i18next';

import { SegmentedControl, SettingRow } from './setting-primitives';

export function ProjectRedirectChecksSetting({
  project,
  onSave,
}: {
  project: Pick<Project, 'id' | 'redirectChecks'>;
  onSave: (projectId: string, data: { redirectChecks: boolean }) => void;
}) {
  const { t } = useTranslation();
  return (
    <SettingRow title={t('settings.redirectChecks')} description={t('settings.redirectChecksDesc')}>
      <SegmentedControl<string>
        value={project.redirectChecks === false ? 'off' : 'on'}
        onChange={(v) => onSave(project.id, { redirectChecks: v === 'on' })}
        options={[
          {
            value: 'off',
            label: t('settings.fastModeOff'),
            testId: 'settings-redirect-checks-off',
          },
          { value: 'on', label: t('settings.fastModeOn'), testId: 'settings-redirect-checks-on' },
        ]}
      />
    </SettingRow>
  );
}
