import { useTranslation } from 'react-i18next';

import { ArchivedThreadsSettings } from '@/components/ArchivedThreadsSettings';
import { AutomationSettings } from '@/components/AutomationSettings';
import { GeneralSettings } from '@/components/GeneralSettings';
import { McpServerSettings } from '@/components/McpServerSettings';
import { PipelineSettings } from '@/components/PipelineSettings';
import { ProjectConfigSettings } from '@/components/ProjectConfigSettings';
import { ProjectHooksSettings } from '@/components/ProjectHooksSettings';
import { type SettingsItemId } from '@/components/settings/items';
import { TeamMembers } from '@/components/settings/TeamMembers';
import { UserManagement } from '@/components/settings/UserManagement';
import { SkillsSettings } from '@/components/SkillsSettings';
import { StartupCommandsSettings } from '@/components/StartupCommandsSettings';
import { WorktreeSettings } from '@/components/WorktreeSettings';

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
      return <ProjectHooksSettings />;
    case 'automations':
      return <AutomationSettings />;
    case 'pipelines':
      return <PipelineSettings />;
    case 'archived-threads':
      return <ArchivedThreadsSettings />;
    case 'users':
      return <UserManagement />;
    case 'team-members':
      return <TeamMembers />;
    default:
      return <p className="text-sm text-muted-foreground">{t('settings.comingSoon', { label })}</p>;
  }
}
