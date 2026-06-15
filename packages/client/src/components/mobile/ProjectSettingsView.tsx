import { ArrowLeft, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  buildSettingsItems,
  settingsLabelKeys,
  type SettingsItemId,
} from '@/components/settings/items';
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
import { useAppStore } from '@/stores/app-store';
import { useAuthStore } from '@/stores/auth-store';
import { useProjectStore } from '@/stores/project-store';

interface Props {
  projectId: string;
  onBack: () => void;
}

/**
 * Mobile project settings. Two screens in one component: a list of every
 * project settings option, drilling into the specific page on tap (and back).
 * Each page reuses the SAME desktop panel via `SettingsPageContent`, just inside
 * a single-column mobile shell instead of the desktop two-pane layout.
 *
 * The page panels read the active project from `useProjectStore.selectedProjectId`,
 * which mobile never sets (it navigates via local view state). We point the store
 * at this project on mount so the panels render the right project.
 */
export function ProjectSettingsView({ projectId, onBack }: Props) {
  const { t } = useTranslation();
  const projects = useAppStore((s) => s.projects);
  const project = projects.find((p) => p.id === projectId);
  const authUser = useAuthStore((s) => s.user);
  const [page, setPage] = useState<SettingsItemId | null>(null);

  useEffect(() => {
    useProjectStore.setState({ selectedProjectId: projectId });
  }, [projectId]);

  // Same gating as the desktop sidebar: shared, server-owned tabs (project
  // defaults + startup commands) are admin-only; collaborators keep the rest.
  const isProjectAdmin =
    project?.role === 'owner' || project?.role === 'admin' || project?.userId === authUser?.id;

  const items = buildSettingsItems({
    selectedProjectId: projectId,
    isProjectAdmin,
  });

  const settingsLabel = t('settings.title', 'Settings');

  // ── Detail screen: a single settings page ──
  if (page) {
    const label = t(settingsLabelKeys[page] ?? page);
    return (
      <>
        <header className="border-border flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <button
            onClick={() => setPage(null)}
            aria-label={t('common.back', 'Back')}
            className="hover:bg-accent -ml-1 rounded p-1"
            data-testid="mobile-project-settings-page-back"
          >
            <ArrowLeft className="icon-lg" />
          </button>
          <Breadcrumb className="min-w-0 flex-1">
            <BreadcrumbList className="flex-nowrap">
              <BreadcrumbItem>
                <BreadcrumbLink asChild className="cursor-pointer truncate">
                  <button
                    type="button"
                    onClick={() => setPage(null)}
                    data-testid="mobile-project-settings-crumb-root"
                  >
                    {project?.name || settingsLabel}
                  </button>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem className="min-w-0">
                <BreadcrumbPage className="truncate">{label}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </header>
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-3 py-4">
            <SettingsPageContent page={page} label={label} />
          </div>
        </ScrollArea>
      </>
    );
  }

  // ── List screen: all project settings options ──
  return (
    <>
      <header className="border-border flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <button
          onClick={onBack}
          aria-label={t('common.back', 'Back')}
          className="hover:bg-accent -ml-1 rounded p-1"
          data-testid="mobile-project-settings-back"
        >
          <ArrowLeft className="icon-lg" />
        </button>
        <Breadcrumb className="min-w-0 flex-1">
          <BreadcrumbList className="flex-nowrap">
            <BreadcrumbItem>
              <span className="text-muted-foreground">{settingsLabel}</span>
            </BreadcrumbItem>
            {project?.name && (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem className="min-w-0">
                  <BreadcrumbPage className="truncate">{project.name}</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            )}
          </BreadcrumbList>
        </Breadcrumb>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col p-2">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                onClick={() => setPage(item.id)}
                data-testid={`mobile-settings-nav-${item.id}`}
                className="hover:bg-accent active:bg-accent flex items-center gap-3 rounded-md px-3 py-3 text-left"
              >
                <Icon className="icon-base text-muted-foreground shrink-0" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {t(settingsLabelKeys[item.id] ?? item.label)}
                </span>
                <ChevronRight className="icon-sm text-muted-foreground shrink-0" />
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </>
  );
}
