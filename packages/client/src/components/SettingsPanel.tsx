import { ArrowLeft, Settings, UserPlus, Users, UsersRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { settingsItems, settingsLabelKeys } from '@/components/settings/items';
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from '@/components/ui/sidebar';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { buildPath } from '@/lib/url';
import { useAuthStore } from '@/stores/auth-store';
import { useProjectStore } from '@/stores/project-store';
import { useUIStore } from '@/stores/ui-store';

/**
 * Project settings tabs backed by SHARED, server-owned state (the projects
 * table + startup_commands DB). Editing these affects every collaborator, so
 * they're limited to project admins. Everything else in the project settings
 * (worktrees, hooks, MCP, skills, .funny.json) proxies to the caller's OWN
 * runner/checkout and is therefore per-user — collaborators keep full access.
 */
const PROJECT_ADMIN_ONLY_TABS: ReadonlySet<string> = new Set(['general', 'startup-commands']);

export function SettingsPanelBody() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const activeSettingsPage = useUIStore((s) => s.activeSettingsPage);
  const settingsReturnPath = useUIStore((s) => s.settingsReturnPath);
  const setSettingsReturnPath = useUIStore((s) => s.setSettingsReturnPath);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const selectedProject = useProjectStore((s) =>
    s.selectedProjectId ? s.projects.find((p) => p.id === s.selectedProjectId) : undefined,
  );
  const authUser = useAuthStore((s) => s.user);

  // Project-config tabs mutate shared project state, so they're limited to the
  // project's admins (owner or `admin` member). Plain collaborators get a
  // read-only experience: the config tabs are hidden (the server also rejects
  // their writes — defense in depth). The owner fallback covers older payloads
  // that predate the `role` field.
  const isProjectAdmin =
    selectedProject?.role === 'owner' ||
    selectedProject?.role === 'admin' ||
    selectedProject?.userId === authUser?.id;

  // Build items list dynamically
  // Hide "Archived Threads" when viewing per-project settings
  let items: Array<{ id: string; label: string; icon: typeof Settings }> = selectedProjectId
    ? [...settingsItems].filter((item) => item.id !== 'archived-threads')
    : [...settingsItems];

  if (selectedProjectId) {
    // ── Project context ──
    if (!isProjectAdmin) {
      // Collaborators may freely configure their OWN runner/checkout — worktrees,
      // hooks, MCP servers, skills and `.funny.json` all proxy to their personal
      // runner, so those stay editable. Only the shared, server-owned config
      // (project defaults + startup commands, stored once in the DB) is gated to
      // project admins.
      items = items.filter((item) => !PROJECT_ADMIN_ONLY_TABS.has(item.id));
    } else {
      // Managing who has access to THIS project is a project-admin action and
      // lives here (not the global Users/Team-Members pages, which are account-
      // and org-level and only appear in global preferences).
      items.push({ id: 'collaborators', label: 'Collaborators', icon: UserPlus });
    }
  } else if (authUser?.role === 'admin') {
    // ── Global context, server admins only ──
    items.push({ id: 'users', label: 'Users', icon: Users });
    items.push({ id: 'team-members', label: 'Team Members', icon: UsersRound });
  }

  const settingsPath = (pageId: string) =>
    selectedProjectId ? `/projects/${selectedProjectId}/settings/${pageId}` : `/settings/${pageId}`;

  return (
    <>
      {/* Header */}
      <SidebarHeader className="px-4 py-3">
        <div className="flex items-center gap-2">
          <TooltipIconButton
            onClick={() => {
              setSettingsOpen(false);
              const target =
                settingsReturnPath ?? (selectedProjectId ? `/projects/${selectedProjectId}` : '/');
              setSettingsReturnPath(null);
              navigate(buildPath(target));
            }}
            className="text-muted-foreground hover:text-foreground"
            data-testid="settings-back"
            tooltip={t('common.back')}
          >
            <ArrowLeft className="icon-sm" />
          </TooltipIconButton>
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
                  <Icon className="icon-base" />
                  <span>{t(settingsLabelKeys[item.id] ?? item.label)}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarContent>
    </>
  );
}

export function SettingsPanel() {
  return (
    <Sidebar collapsible="offcanvas">
      <SettingsPanelBody />
    </Sidebar>
  );
}
