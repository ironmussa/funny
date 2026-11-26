import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { KanbanView } from '@/components/KanbanView';
import { useProjects } from '@/data/projects/hooks';
import { useLoadedThreads } from '@/data/threads/hooks';
import { useThreadStore } from '@/stores/thread-store';

/**
 * The kanban board of every project, shown in the left sidebar in place of
 * the thread list (`leftPanelMode === 'kanban'`, toggled from the tool rail).
 * Opening a card shows its thread in the center while the board stays here.
 */
export function KanbanSidebarView() {
  const { t } = useTranslation();
  const projects = useProjects();
  const threads = useLoadedThreads(null);

  // The "Archived" column needs archived threads loaded; other loads skip them.
  useEffect(() => {
    for (const project of projects) {
      useThreadStore.getState().loadThreadsForProject(project.id, true);
    }
  }, [projects]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col" data-testid="kanban-sidebar-view">
      <div className="border-border flex h-12 shrink-0 items-center border-b px-4">
        <h2 className="text-sm font-medium">{t('sidebar.kanbanView', 'Kanban')}</h2>
      </div>
      <div className="min-h-0 flex-1">
        <KanbanView threads={threads} />
      </div>
    </div>
  );
}
