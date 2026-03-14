import {
  ArrowLeft,
  Settings,
  Server,
  Sparkles,
  GitFork,
  Terminal,
  FileJson2,
  Webhook,
  Timer,
  Archive,
  Users,
  UsersRound,
  Workflow,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from '@/components/ui/sidebar';
import { buildPath } from '@/lib/url';
import { useAuthStore } from '@/stores/auth-store';
import { useProjectStore } from '@/stores/project-store';
import { useUIStore } from '@/stores/ui-store';

const baseSettingsItems = [
  { id: 'general', label: 'General', icon: Settings },
  { id: 'mcp-server', label: 'MCP Server', icon: Server },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'worktrees', label: 'Worktrees', icon: GitFork },
  { id: 'startup-commands', label: 'Startup Commands', icon: Terminal },
  { id: 'project-config', label: 'Project Config', icon: FileJson2 },
  { id: 'hooks', label: 'Hooks', icon: Webhook },
  { id: 'automations', label: 'Automations', icon: Timer },
  { id: 'pipelines', label: 'Pipelines', icon: Workflow },
  { id: 'archived-threads', label: 'Archived Threads', icon: Archive },
] as const;

export const settingsItems = baseSettingsItems;
export type SettingsItemId = (typeof baseSettingsItems)[number]['id'] | 'users' | 'team-members';

export const settingsLabelKeys: Record<string, string> = {
  general: 'settings.general',
  'mcp-server': 'settings.mcpServer',
  skills: 'settings.skills',
  worktrees: 'settings.worktrees',
  'startup-commands': 'startup.title',
  'project-config': 'projectConfig.title',
  hooks: 'hooks.title',
  automations: 'settings.automations',
  pipelines: 'settings.pipelines',
  'archived-threads': 'settings.archivedThreads',
  users: 'users.title',
  'team-members': 'Team Members',
};

export function SettingsPanel() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const activeSettingsPage = useUIStore((s) => s.activeSettingsPage);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const authUser = useAuthStore((s) => s.user);

  // Build items list dynamically
  // Hide "Archived Threads" when viewing per-project settings
  const items: Array<{ id: string; label: string; icon: typeof Settings }> = selectedProjectId
    ? [...baseSettingsItems].filter((item) => item.id !== 'archived-threads')
    : [...baseSettingsItems];
  if (authUser?.role === 'admin') {
    items.push({ id: 'users', label: 'Users', icon: Users });
    items.push({ id: 'team-members', label: 'Team Members', icon: UsersRound });
  }

  const settingsPath = (pageId: string) =>
    selectedProjectId ? `/projects/${selectedProjectId}/settings/${pageId}` : `/settings/${pageId}`;

  return (
    <Sidebar collapsible="offcanvas">
      {/* Header */}
      <SidebarHeader className="px-4 py-3">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => {
              setSettingsOpen(false);
              navigate(buildPath(selectedProjectId ? `/projects/${selectedProjectId}` : '/'));
            }}
            className="text-muted-foreground hover:text-foreground"
            data-testid="settings-back"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
          <h1 className="text-sm font-medium">{t('settings.title')}</h1>
        </div>
      </SidebarHeader>

      {/* Menu list */}
      <SidebarContent className="px-2 pb-2">
        <SidebarMenu>
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  isActive={activeSettingsPage === item.id}
                  onClick={() => navigate(buildPath(settingsPath(item.id)))}
                  data-testid={`settings-nav-${item.id}`}
                >
                  <Icon className="h-4 w-4" />
                  <span>{t(settingsLabelKeys[item.id] ?? item.label)}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarContent>
    </Sidebar>
  );
}
