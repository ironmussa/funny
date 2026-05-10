import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useMinuteTick } from '@/hooks/use-minute-tick';
import { useProjectStore } from '@/stores/project-store';
import { useThreadCore } from '@/stores/thread-context';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

import { NewThreadInput } from './thread/NewThreadInput';
import { ProjectHeader } from './thread/ProjectHeader';
import { ThreadChatView } from './thread/ThreadChatView';
import { ThreadIdleStarter } from './thread/ThreadIdleStarter';
import { WorktreeSetupProgress } from './WorktreeSetupProgress';

// Re-exports for backwards compatibility (used by MobilePage.tsx).
export { MessageContent, CopyButton } from '@/components/thread/MessageContent';
export { WaitingActions } from '@/components/thread/WaitingCards';

export function ThreadView() {
  const { t } = useTranslation();
  useMinuteTick(); // re-render every 60s so timeAgo stays fresh
  const activeThread = useThreadCore();
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const newThreadProjectId = useUIStore((s) => s.newThreadProjectId);
  const hasProjects = useProjectStore((s) => s.projects.length > 0);

  // Show new thread input when a project's "+" was clicked
  if (newThreadProjectId && !selectedThreadId) {
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <ProjectHeader />
        <NewThreadInput />
      </div>
    );
  }

  if (!selectedThreadId) {
    if (selectedProjectId && hasProjects) {
      return (
        <div className="flex h-full min-w-0 flex-1 flex-col">
          <ProjectHeader />
          <NewThreadInput />
        </div>
      );
    }
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <div className="flex flex-1 items-center justify-center px-6 text-muted-foreground">
          <div className="max-w-3xl text-center">
            <p className="mb-4 text-4xl">{hasProjects ? '🚀' : '📁'}</p>
            <p className="mb-1 text-2xl font-semibold text-foreground">
              {hasProjects ? t('thread.selectOrCreate') : t('thread.addProjectFirst')}
            </p>
            <p className="text-sm">
              {hasProjects ? t('thread.threadsRunParallel') : t('thread.addProjectDescription')}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!activeThread) {
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col">
        {selectedProjectId && <ProjectHeader />}
        <div className="flex flex-1 items-center justify-center px-4 text-muted-foreground">
          <div className="flex w-full max-w-md flex-col items-center justify-center gap-4">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground/50" />
            <span className="text-sm text-muted-foreground/60">Preparing...</span>
          </div>
        </div>
      </div>
    );
  }

  if (activeThread.status === 'setting_up') {
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <ProjectHeader />
        <div className="flex flex-1 items-center justify-center px-4">
          <WorktreeSetupProgress steps={activeThread.setupProgress ?? []} />
        </div>
      </div>
    );
  }

  const uiQueuedCount = activeThread.queuedCount ?? 0;
  const isIdle = activeThread.status === 'idle' && uiQueuedCount === 0;
  if (isIdle) return <ThreadIdleStarter activeThread={activeThread} />;

  return <ThreadChatView activeThread={activeThread} />;
}
