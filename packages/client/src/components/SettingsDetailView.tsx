import { useTranslation } from 'react-i18next';

import { settingsLabelKeys, type SettingsItemId } from '@/components/settings/items';
import { SettingsPageContent } from '@/components/settings/SettingsPageContent';
import { useSettingFocusScroll } from '@/components/settings/use-settings-filter';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useProjects } from '@/data/projects/hooks';
import { useProjectStore } from '@/stores/project-store';
import { useUIStore } from '@/stores/ui-store';

export function SettingsDetailView() {
  const { t } = useTranslation();
  const activeSettingsPage = useUIStore((s) => s.activeSettingsPage);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const projects = useProjects();
  // SAFETY: only use-view-route-sync sets activeSettingsPage, and only to an id in
  // routableSettingsIds, which is built from the settings item ids.
  const page = activeSettingsPage as SettingsItemId | null;
  const label = page ? t(settingsLabelKeys[page] ?? page) : null;
  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  useSettingFocusScroll();

  if (!page) {
    return (
      <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
        {t('settings.selectSetting')}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="border-border border-b px-4 py-2">
        <div className="flex min-h-8 items-center">
          <Breadcrumb>
            <BreadcrumbList>
              {selectedProject && (
                <BreadcrumbItem>
                  <BreadcrumbLink truncate className="cursor-default">
                    {selectedProject.name}
                  </BreadcrumbLink>
                </BreadcrumbItem>
              )}
              {selectedProject && <BreadcrumbSeparator />}
              <BreadcrumbItem>
                <BreadcrumbPage truncate>{label}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </div>

      {/* Archived threads owns its own scroll + full width (mirrors /list);
          every other settings page renders in the centered, padded column. */}
      {page === 'archived-threads' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <SettingsPageContent page={page} label={label ?? ''} />
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="max-w-4xl px-8 py-8">
            <SettingsPageContent page={page} label={label ?? ''} />
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
