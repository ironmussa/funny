import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { buildSettingsItems, settingsLabelKeys } from '@/components/settings/items';
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

  const items = buildSettingsItems({
    selectedProjectId,
    isProjectAdmin,
  });

  const settingsPath = (pageId: string) =>
    selectedProjectId ? `/projects/${selectedProjectId}/settings/${pageId}` : `/settings/${pageId}`;

  return (
    <>
      {/* Header */}
      <SidebarHeader className="px-4 py-3">
        <div className="flex items-center gap-2">
          <TooltipIconButton
            onClick={() => {
              // Don't close the overlay imperatively — let route-sync close it
              // AFTER the URL becomes the thread route. Closing it here reveals
              // ThreadView one render before the URL updates, flashing the empty
              // new-thread compose input. See use-view-route-sync.ts.
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
