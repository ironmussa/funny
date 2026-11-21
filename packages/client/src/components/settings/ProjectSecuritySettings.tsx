import { ProjectSecretsSetting } from '@/components/general-settings-project/ProjectSecretsSetting';
import { useProjectStore } from '@/stores/project-store';

/** The project's Security page: the secrets its agents get as environment variables. */
export function ProjectSecuritySettings() {
  const projectId = useProjectStore((s) => s.selectedProjectId);
  if (!projectId) return null;
  return (
    <div data-testid="settings-security-page">
      <ProjectSecretsSetting projectId={projectId} />
    </div>
  );
}
