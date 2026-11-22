import { ArrowLeft } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import {
  SettingsNavFilter,
  type OtherSettingsSurface,
} from '@/components/settings/SettingsNavFilter';
import {
  usePreferencesNavPages,
  useProjectSettingsNavPages,
} from '@/components/settings/use-settings-filter';
import { Sidebar, SidebarContent, SidebarHeader } from '@/components/ui/sidebar';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { buildPath } from '@/lib/url';
import { useSettingsFilterStore } from '@/stores/settings-filter-store';
import { useUIStore } from '@/stores/ui-store';

export function SettingsPanelBody() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const activeSettingsPage = useUIStore((s) => s.activeSettingsPage);
  const settingsReturnPath = useUIStore((s) => s.settingsReturnPath);
  const setSettingsReturnPath = useUIStore((s) => s.setSettingsReturnPath);
  const resetFilter = useSettingsFilterStore((s) => s.reset);

  // Which pages a member may open (project-admin / owner gating) is decided
  // by buildSettingsItems, behind this hook.
  const { selectedProjectId, pages } = useProjectSettingsNavPages();
  const preferencesPages = usePreferencesNavPages();
  const other = useMemo<OtherSettingsSurface>(
    () => ({
      scope: 'preferences',
      pages: preferencesPages,
      openPage: (id) => navigate(buildPath(`/preferences/${id}`)),
    }),
    [preferencesPages, navigate],
  );

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
              resetFilter();
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
        <SettingsNavFilter
          scope="project"
          pages={pages}
          activePageId={activeSettingsPage}
          openPage={(id) => navigate(buildPath(settingsPath(id)))}
          testIdPrefix="settings"
          other={other}
        />
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
