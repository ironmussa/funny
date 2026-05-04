import { ArrowLeft, Plus } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { StatusBadge } from '@/components/StatusBadge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAppStore } from '@/stores/app-store';

interface Props {
  projectId: string;
  onBack: () => void;
  onSelectThread: (threadId: string) => void;
  onNewThread: () => void;
}

export function ThreadListView({ projectId, onBack, onSelectThread, onNewThread }: Props) {
  const { t } = useTranslation();
  const projects = useAppStore((s) => s.projects);
  const threadsByProject = useAppStore((s) => s.threadsByProject);
  const loadThreadsForProject = useAppStore((s) => s.loadThreadsForProject);

  const project = projects.find((p) => p.id === projectId);
  const threads = threadsByProject[projectId] ?? [];

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
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <button
          onClick={onBack}
          aria-label={t('common.back', 'Back')}
          className="-ml-1 rounded p-1 hover:bg-accent"
        >
          <ArrowLeft className="icon-lg" />
        </button>
        <h1 className="flex-1 truncate text-base font-semibold">{project?.name ?? 'Project'}</h1>
        <button
          onClick={onNewThread}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground active:bg-primary/80"
        >
          <Plus className="icon-sm" />
          {t('sidebar.newThread', 'New')}
        </button>
      </header>
      <ScrollArea className="flex-1">
        {sortedThreads.length === 0 ? (
          <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
            {t('sidebar.noThreads', 'No threads yet. Create one to start.')}
          </div>
        ) : (
          <div className="space-y-1 p-2">
            {sortedThreads.map((thread) => (
              <button
                key={thread.id}
                onClick={() => onSelectThread(thread.id)}
                className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left transition-colors hover:bg-accent active:bg-accent/80"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{thread.title}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
                      new Date(thread.createdAt),
                    )}
                  </div>
                </div>
                <StatusBadge status={thread.status} />
              </button>
            ))}
          </div>
        )}
      </ScrollArea>
    </>
  );
}
