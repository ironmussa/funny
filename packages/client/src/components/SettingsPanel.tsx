import { ArrowLeft, Settings, Users, UsersRound } from 'lucide-react';
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

export function SettingsPanelBody() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const activeSettingsPage = useUIStore((s) => s.activeSettingsPage);
  const settingsReturnPath = useUIStore((s) => s.settingsReturnPath);
  const setSettingsReturnPath = useUIStore((s) => s.setSettingsReturnPath);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const authUser = useAuthStore((s) => s.user);

  // Build items list dynamically
  // Hide "Archived Threads" when viewing per-project settings
  const items: Array<{ id: string; label: string; icon: typeof Settings }> = selectedProjectId
    ? [...settingsItems].filter((item) => item.id !== 'archived-threads')
    : [...settingsItems];
  if (authUser?.role === 'admin') {
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
