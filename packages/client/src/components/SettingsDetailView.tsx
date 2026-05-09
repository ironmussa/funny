import { useTranslation } from 'react-i18next';

import { settingsLabelKeys, type SettingsItemId } from '@/components/settings/items';
import { SettingsPageContent } from '@/components/settings/SettingsPageContent';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useProjectStore } from '@/stores/project-store';
import { useUIStore } from '@/stores/ui-store';

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

      <ScrollArea className="min-h-0 flex-1">
        <div className="max-w-4xl px-8 py-8">
          <SettingsPageContent page={page} label={label ?? ''} />
        </div>
      </ScrollArea>
    </div>
  );
}
