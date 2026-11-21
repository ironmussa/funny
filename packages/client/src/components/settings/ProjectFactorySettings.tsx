import { useTranslation } from 'react-i18next';

import { ProjectFactoryFlows } from '@/components/general-settings-project/ProjectFactoryFlows';
import { ProjectFactorySetting } from '@/components/general-settings-project/ProjectFactorySetting';
import { useCanSteerProject } from '@/data/projects/hooks';
import { useProjectStore } from '@/stores/project-store';

/**
 * The project's Factory page: the caller's own issue factory (status, mode,
 * runs) and the flows it can run, each with its YAML.
 */
export function ProjectFactorySettings() {
  const { t } = useTranslation();
  const projectId = useProjectStore((s) => s.selectedProjectId);
  const canSteer = useCanSteerProject(projectId ?? '');
  if (!projectId) return null;
  return (
    <div data-testid="settings-factory-page">
      {canSteer ? (
        <ProjectFactorySetting projectId={projectId} />
      ) : (
        <p className="text-muted-foreground px-1 pb-4 text-sm">
          {t(
            'settings.projectFactoryViewerNote',
            'Running an issue factory needs contributor access to the project.',
          )}
        </p>
      )}
      <ProjectFactoryFlows projectId={projectId} />
    </div>
  );
}
