import { useTranslation } from 'react-i18next';

import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useProjectStore } from '@/stores/project-store';
import { useUIStore } from '@/stores/ui-store';

import { ArchivedThreadsSettings } from './ArchivedThreadsSettings';
import { AutomationSettings } from './AutomationSettings';
import { GeneralSettings } from './GeneralSettings';
import { McpServerSettings } from './McpServerSettings';
import { PipelineSettings } from './PipelineSettings';
import { ProjectConfigSettings } from './ProjectConfigSettings';
import { ProjectHooksSettings } from './ProjectHooksSettings';
import { TeamMembers } from './settings/TeamMembers';
import { UserManagement } from './settings/UserManagement';
import { settingsLabelKeys, type SettingsItemId } from './SettingsPanel';
import { SkillsSettings } from './SkillsSettings';
import { StartupCommandsSettings } from './StartupCommandsSettings';
import { WorktreeSettings } from './WorktreeSettings';

export function SettingsDetailView() {
  const { t } = useTranslation();
  const activeSettingsPage = useUIStore((s) => s.activeSettingsPage);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const projects = useProjectStore((s) => s.projects);
  const page = activeSettingsPage as SettingsItemId | null;
  const label = page ? t(settingsLabelKeys[page] ?? page) : null;
  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  if (!page) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {t('settings.selectSetting')}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/* Page header */}
      <div className="border-b border-border px-4 py-2">
        <div className="flex min-h-8 items-center">
          <Breadcrumb>
            <BreadcrumbList>
              {selectedProject && (
                <BreadcrumbItem>
                  <BreadcrumbLink className="cursor-default truncate text-sm">
                    {selectedProject.name}
                  </BreadcrumbLink>
                </BreadcrumbItem>
              )}
              {selectedProject && <BreadcrumbSeparator />}
              <BreadcrumbItem>
                <BreadcrumbPage className="truncate text-sm">{label}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </div>

      {/* Page content */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="max-w-4xl px-8 py-8">
          {page === 'general' ? (
            <GeneralSettings />
          ) : page === 'mcp-server' ? (
            <McpServerSettings />
          ) : page === 'skills' ? (
            <SkillsSettings />
          ) : page === 'worktrees' ? (
            <WorktreeSettings />
          ) : page === 'startup-commands' ? (
            <StartupCommandsSettings />
          ) : page === 'project-config' ? (
            <ProjectConfigSettings />
          ) : page === 'hooks' ? (
            <ProjectHooksSettings />
          ) : page === 'automations' ? (
            <AutomationSettings />
          ) : page === 'pipelines' ? (
            <PipelineSettings />
          ) : page === 'archived-threads' ? (
            <ArchivedThreadsSettings />
          ) : page === 'users' ? (
            <UserManagement />
          ) : page === 'team-members' ? (
            <TeamMembers />
          ) : (
            <p className="text-sm text-muted-foreground">{t('settings.comingSoon', { label })}</p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
