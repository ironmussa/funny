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
  // SAFETY: the page id comes from the /preferences/:page route, which links build
  // from GeneralPage ids. An unknown id from a hand-typed URL is tolerated:
  // preferencesPageLabel returns it as-is and PreferencesContent renders no page.
  const activePreferencesPage = useUIStore((s) => s.activePreferencesPage) as GeneralPage;
  const label = preferencesPageLabel(activePreferencesPage, t);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="border-border border-b px-4 py-2">
        <div className="flex min-h-8 items-center">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage truncate>{label}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </div>

      <PreferencesContent activePreferencesPage={activePreferencesPage} />
    </div>
  );
}
