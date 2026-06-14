import { ArrowLeft, Plus, Search, Settings } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { VirtualThreadList } from '@/components/VirtualThreadList';
import { useThreadsForProject } from '@/lib/thread-selectors';
import { useAppStore } from '@/stores/app-store';

interface Props {
  projectId: string;
  onBack: () => void;
  onSelectThread: (threadId: string) => void;
  onNewThread: () => void;
  onSearch: () => void;
  onSettings: () => void;
}

export function ThreadListView({
  projectId,
  onBack,
  onSelectThread,
  onNewThread,
  onSearch,
  onSettings,
}: Props) {
  const { t } = useTranslation();
  const projects = useAppStore((s) => s.projects);
  const loadThreadsForProject = useAppStore((s) => s.loadThreadsForProject);
  const threads = useThreadsForProject(projectId);

  const project = projects.find((p) => p.id === projectId);

  useEffect(() => {
    loadThreadsForProject(projectId);
  }, [projectId, loadThreadsForProject]);

  const sortedThreads = [...threads]
    .filter((th) => !th.archived)
    .sort((a, b) => {
      const runningStatuses = ['running', 'waiting'];
      const aRunning = runningStatuses.includes(a.status) ? 0 : 1;
      const bRunning = runningStatuses.includes(b.status) ? 0 : 1;
      if (aRunning !== bRunning) return aRunning - bRunning;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

  return (
    <>
      <header className="border-border flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <button
          onClick={onBack}
          aria-label={t('common.back', 'Back')}
          className="hover:bg-accent -ml-1 rounded p-1"
        >
          <ArrowLeft className="icon-lg" />
        </button>
        <h1 className="flex-1 truncate text-base font-semibold">{project?.name ?? 'Project'}</h1>
        <button
          onClick={onSearch}
          aria-label={t('sidebar.search', 'Search')}
          className="hover:bg-accent rounded p-1.5"
          data-testid="mobile-thread-search"
        >
          <Search className="icon-sm" />
        </button>
        <button
          onClick={onSettings}
          aria-label={t('settings.title', 'Settings')}
          className="hover:bg-accent rounded p-1.5"
          data-testid="mobile-thread-settings"
        >
          <Settings className="icon-sm" />
        </button>
        <button
          onClick={onNewThread}
          className="bg-primary text-primary-foreground active:bg-primary/80 flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium"
        >
          <Plus className="icon-sm" />
          {t('sidebar.newThread', 'New')}
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col px-3 py-2">
        <VirtualThreadList
          threads={sortedThreads}
          search=""
          emptyMessage={t('sidebar.noThreads', 'No threads yet. Create one to start.')}
          searchEmptyMessage={t('sidebar.noThreads', 'No threads yet. Create one to start.')}
          hideBranch
          onThreadClick={(thread) => onSelectThread(thread.id)}
        />
      </div>
    </>
  );
}
