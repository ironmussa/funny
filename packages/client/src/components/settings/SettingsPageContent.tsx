import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';

import { AgentResourcesSettings } from '@/components/AgentResourcesSettings';
import { ArchivedThreadsSettings } from '@/components/ArchivedThreadsSettings';
import { AutomationSettings } from '@/components/AutomationSettings';
import { GeneralSettings } from '@/components/GeneralSettings';
import { McpServerSettings } from '@/components/McpServerSettings';
import { PipelineSettings } from '@/components/PipelineSettings';
import { ProjectConfigSettings } from '@/components/ProjectConfigSettings';
import { type SettingsItemId } from '@/components/settings/items';
import { ProjectCollaborators } from '@/components/settings/ProjectCollaborators';
import { SkillsSettings } from '@/components/SkillsSettings';
import { StartupCommandsSettings } from '@/components/StartupCommandsSettings';
import { LoadingState } from '@/components/ui/loading-state';
import { WorktreeSettings } from '@/components/WorktreeSettings';

// Lazy-loaded: pulls in Monaco editor (~3MB) only when the user opens this page
const ProjectHooksSettings = lazy(() =>
  import('@/components/ProjectHooksSettings').then((m) => ({ default: m.ProjectHooksSettings })),
);

interface Props {
  page: SettingsItemId;
  label: string;
}

/**
 * Routes the active settings page id to its dedicated settings panel.
 * Pulled out of SettingsDetailView so the parent only imports this single
 * dispatch component instead of all 12 page modules.
 */
export function SettingsPageContent({ page, label }: Props) {
  const { t } = useTranslation();

  switch (page) {
    case 'general':
      return <GeneralSettings />;
    case 'agent-resources':
      return <AgentResourcesSettings />;
    case 'mcp-server':
      return <McpServerSettings />;
    case 'skills':
      return <SkillsSettings />;
    case 'worktrees':
      return <WorktreeSettings />;
    case 'startup-commands':
      return <StartupCommandsSettings />;
    case 'project-config':
      return <ProjectConfigSettings />;
    case 'hooks':
      return (
        <Suspense fallback={<LoadingState label="Loading…" className="min-h-[40vh]" />}>
          <ProjectHooksSettings />
        </Suspense>
      );
    case 'automations':
      return <AutomationSettings />;
    case 'pipelines':
      return <PipelineSettings />;
    case 'archived-threads':
      return <ArchivedThreadsSettings />;
    case 'collaborators':
      return <ProjectCollaborators />;
    default:
      return <p className="text-muted-foreground text-sm">{t('settings.comingSoon', { label })}</p>;
  }
}
