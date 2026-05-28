import { useTranslation } from 'react-i18next';

import { PreferencesContent } from '@/components/general-settings/PreferencesContent';
import { preferencesPageLabel, type GeneralPage } from '@/components/PreferencesPanel';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbPage,
  BreadcrumbList,
} from '@/components/ui/breadcrumb';
import { useUIStore } from '@/stores/ui-store';

export function GeneralSettingsView() {
  const { t } = useTranslation();
  const activePreferencesPage = useUIStore((s) => s.activePreferencesPage) as GeneralPage;
  const label = preferencesPageLabel(activePreferencesPage, t);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-4 py-2">
        <div className="flex min-h-8 items-center">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage className="truncate text-sm">{label}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </div>

      <PreferencesContent activePreferencesPage={activePreferencesPage} />
    </div>
  );
}
