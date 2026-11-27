import type { AgentProvider, Project } from '@funny/shared';
import { DEFAULT_PROVIDER, getDefaultModel } from '@funny/shared/models';
import { useTranslation } from 'react-i18next';

import type { UpdateProjectInput } from '@/lib/api/projects';
import { getEffortLevels, normalizeEffort, PROVIDERS } from '@/lib/providers';

import { ModelCombobox } from './ModelCombobox';
import { SegmentedControl, ProjectSettingRow } from './setting-primitives';
import { useProviderModelOptions } from './use-provider-model-options';

/** The project's default provider, model and effort for new threads. */
export function ProjectDefaultModelSetting({
  project: selectedProject,
  onSave: saveProject,
}: {
  project: Pick<Project, 'id' | 'defaultProvider' | 'defaultModel' | 'defaultEffort'>;
  onSave: (projectId: string, data: UpdateProjectInput) => void;
}) {
  const { t } = useTranslation();

  const projectDefaultProvider = selectedProject.defaultProvider || DEFAULT_PROVIDER;
  const projectDefaultModel =
    selectedProject.defaultModel || getDefaultModel(projectDefaultProvider);
  const projectEffortOptions = getEffortLevels(projectDefaultModel, projectDefaultProvider);
  const projectDefaultEffort = normalizeEffort(
    projectDefaultModel,
    projectDefaultProvider,
    selectedProject.defaultEffort,
  );
  const projectModelOptions = useProviderModelOptions(projectDefaultProvider);

  return (
    <>
      <ProjectSettingRow
        settingId="project-general.default-model"
        title={t('settings.projectDefaultModel', 'Default Model')}
        description={t(
          'settings.projectDefaultModelDesc',
          'Provider and model for new threads in this project',
        )}
      >
        <div className="flex items-center gap-2">
          <ModelCombobox
            value={selectedProject.defaultProvider || DEFAULT_PROVIDER}
            onChange={(v) => {
              // SAFETY: the combobox only offers PROVIDERS, whose values are AgentProviders.
              const p = v as AgentProvider;
              const model = getDefaultModel(p);
              saveProject(selectedProject.id, {
                defaultProvider: p,
                defaultModel: model,
                defaultEffort: normalizeEffort(model, p, selectedProject.defaultEffort) || null,
              });
            }}
            options={PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
            placeholder={t('settings.selectProvider')}
            searchPlaceholder={t('settings.searchProvider')}
          />
          <ModelCombobox
            value={projectDefaultModel}
            onChange={(v) =>
              saveProject(selectedProject.id, {
                defaultModel: v,
                defaultEffort:
                  normalizeEffort(v, projectDefaultProvider, selectedProject.defaultEffort) || null,
              })
            }
            options={projectModelOptions}
            placeholder={t('settings.selectModel')}
            searchPlaceholder={t('settings.searchModel')}
          />
        </div>
      </ProjectSettingRow>
      {projectEffortOptions.length > 0 && (
        <ProjectSettingRow
          settingId="project-general.default-effort"
          title={t('settings.projectDefaultEffort')}
          description={t('settings.projectDefaultEffortDesc')}
        >
          <SegmentedControl<string>
            value={projectDefaultEffort}
            onChange={(v) => saveProject(selectedProject.id, { defaultEffort: v })}
            options={projectEffortOptions.map((level) => ({
              value: level.value,
              label: t(`settings.effort.${level.value}`, level.label),
              testId: `settings-default-effort-${level.value}`,
            }))}
          />
        </ProjectSettingRow>
      )}
    </>
  );
}
