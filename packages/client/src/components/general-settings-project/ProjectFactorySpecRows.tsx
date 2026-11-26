/**
 * The spec stage of the caller's issue factory (openspec factory-spec-stage):
 * whether triage may park an issue with open product decisions for a spec
 * the team approves, and where the implementer commits an approved spec.
 */
import { isRepositoryRelativePath } from '@funny/shared/contracts/factory';
import { useTranslation } from 'react-i18next';

import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import type { SaveFactorySettingsInput } from '@/lib/api/factory';

import { ProjectSettingRow } from './setting-primitives';

export function ProjectFactorySpecRows({
  specStage,
  commitSpecPath,
  rowKey,
  onSave,
}: {
  specStage: boolean;
  commitSpecPath: string;
  /** Changes after every save, so the input re-reads the confirmed value. */
  rowKey: string;
  onSave: (input: Pick<SaveFactorySettingsInput, 'specStage' | 'commitSpecPath'>) => void;
}) {
  const { t } = useTranslation();
  const savePath = (value: string) => {
    const next = value.trim().replace(/\/+$/, '');
    if (next === commitSpecPath) return;
    if (next && !isRepositoryRelativePath(next)) {
      toast.error(
        t(
          'settings.projectFactoryCommitSpecInvalid',
          'Use a folder inside the repository, such as docs/specs, without ..',
        ),
      );
      return;
    }
    onSave({ commitSpecPath: next });
  };
  return (
    <>
      <ProjectSettingRow
        settingId="factory.specStage"
        title={t('settings.projectFactorySpecStage', 'Spec stage')}
        description={t(
          'settings.projectFactorySpecStageDesc',
          'When triage finds product decisions an issue leaves open, a spec writer settles them with your team in its own thread, and the factory implements the issue only after a member approves the spec',
        )}
      >
        <Switch
          checked={specStage}
          onCheckedChange={(checked) => onSave({ specStage: checked })}
          data-testid="settings-factory-spec-stage"
        />
      </ProjectSettingRow>

      <ProjectSettingRow
        settingId="factory.commitSpecPath"
        title={t('settings.projectFactoryCommitSpec', 'Commit spec')}
        description={t(
          'settings.projectFactoryCommitSpecDesc',
          'A folder in the repository where the implementer commits the approved spec as issue-<number>.md. Empty: the spec is not committed',
        )}
      >
        <Input
          key={`${rowKey}-${commitSpecPath}`}
          defaultValue={commitSpecPath}
          placeholder="docs/specs"
          className="w-[220px]"
          data-testid="settings-factory-commit-spec-path"
          onBlur={(e) => savePath(e.target.value)}
        />
      </ProjectSettingRow>
    </>
  );
}
