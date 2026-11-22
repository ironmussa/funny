import { ArrowLeft } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import {
  PREFERENCES_NAV_ITEMS,
  preferencesItemLabel,
  type GeneralPage,
} from '@/components/settings/preferences-items';
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

export {
  ADMIN_ONLY_PREFERENCES,
  buildPreferencesItems,
  PREFERENCES_NAV_ITEMS,
  type GeneralPage,
} from '@/components/settings/preferences-items';

export function preferencesPageLabel(page: GeneralPage, t: (key: string) => string): string {
  const item = PREFERENCES_NAV_ITEMS.find((i) => i.id === page);
  if (!item) return page;
  return preferencesItemLabel(item.label, t);
}

export function PreferencesPanelBody() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const activePreferencesPage = useUIStore((s) => s.activePreferencesPage) as GeneralPage;
  const settingsReturnPath = useUIStore((s) => s.settingsReturnPath);
  const setSettingsReturnPath = useUIStore((s) => s.setSettingsReturnPath);
  const resetFilter = useSettingsFilterStore((s) => s.reset);
  const pages = usePreferencesNavPages();
  const project = useProjectSettingsNavPages();

  // Project Settings only exist for a selected project, so the hint does too.
  const projectId = project.selectedProjectId;
  const other = useMemo<OtherSettingsSurface | null>(
    () =>
      projectId
        ? {
            scope: 'project',
            pages: project.pages,
            openPage: (id) => navigate(buildPath(`/projects/${projectId}/settings/${id}`)),
          }
        : null,
    [projectId, project.pages, navigate],
  );

  return (
    <>
      <SidebarHeader className="px-4 py-3">
        <div className="flex items-center gap-2">
          <TooltipIconButton
            onClick={() => {
              // Don't close the overlay imperatively — let route-sync close it
              // AFTER the URL becomes the thread route. Closing it here reveals
              // ThreadView one render before the URL updates, flashing the empty
              // new-thread compose input. See use-view-route-sync.ts.
              const target = settingsReturnPath ?? '/';
              setSettingsReturnPath(null);
              resetFilter();
              navigate(buildPath(target));
            }}
            className="text-muted-foreground hover:text-foreground"
            data-testid="preferences-back"
            tooltip={t('common.back')}
          >
            <ArrowLeft className="icon-sm" />
          </TooltipIconButton>
          <h1 className="text-sm font-medium">{t('settings.title')}</h1>
        </div>
      </SidebarHeader>

      <SidebarContent className="px-2 pb-2">
        <SettingsNavFilter
          scope="preferences"
          pages={pages}
          activePageId={activePreferencesPage}
          openPage={(id) => navigate(buildPath(`/preferences/${id}`))}
          testIdPrefix="preferences"
          other={other}
        />
      </SidebarContent>
    </>
  );
}

export function PreferencesPanel() {
  return (
    <Sidebar collapsible="offcanvas">
      <PreferencesPanelBody />
    </Sidebar>
  );
}
