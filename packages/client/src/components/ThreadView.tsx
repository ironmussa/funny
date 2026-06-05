import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/ui/loading-state';
import { useActiveThreadId } from '@/hooks/use-active-thread-id';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/app-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadCore } from '@/stores/thread-context';
import { useUIStore } from '@/stores/ui-store';

import { NewThreadInput } from './thread/NewThreadInput';
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
  // Which thread is active is the URL's call, not the async selectedThreadId.
  const activeThreadId = useActiveThreadId();
  const isThreadSwitching =
    !!activeThreadId && !!activeThread && activeThread.id !== activeThreadId;
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const newThreadProjectId = useUIStore((s) => s.newThreadProjectId);
  const newThreadIsScratch = useUIStore((s) => s.newThreadIsScratch);
  const hasProjects = useProjectStore((s) => s.projects.length > 0);
  const setAddProjectOpen = useAppStore((s) => s.setAddProjectOpen);

  // Scratch compose: no project / no header — just the prompt input.
  if (newThreadIsScratch && !activeThreadId) {
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <NewThreadInput />
      </div>
    );
  }

  // Show new thread input when a project's "+" was clicked. ProjectHeader
  // is rendered at the app shell level (top edge group), so no header here.
  if (newThreadProjectId && !activeThreadId) {
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <NewThreadInput />
      </div>
    );
  }

  if (!activeThreadId) {
    if (selectedProjectId && hasProjects) {
      return (
        <div className="flex h-full min-w-0 flex-1 flex-col">
          <NewThreadInput />
        </div>
      );
    }
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <div className="text-muted-foreground flex flex-1 items-center justify-center px-6">
          <div className="max-w-3xl text-center">
            <p className="mb-4 text-4xl">{hasProjects ? '🚀' : '📁'}</p>
            <p className="text-foreground mb-1 text-2xl font-semibold">
              {hasProjects ? t('thread.selectOrCreate') : t('thread.addProjectFirst')}
            </p>
            <p className="text-sm">
              {hasProjects ? t('thread.threadsRunParallel') : t('thread.addProjectDescription')}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAddProjectOpen(true)}
              className="mt-6"
              data-testid="thread-empty-add-project"
            >
              <Plus className="icon-sm" />
              {t('sidebar.addProject')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!activeThread) {
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <LoadingState
          testId="thread-loading-placeholder"
          label={t('common.preparing', 'Preparing…')}
        />
      </div>
    );
  }

  const threadBody =
    activeThread.status === 'setting_up' ? (
      <div className="flex flex-1 items-center justify-center px-4">
        <WorktreeSetupProgress steps={activeThread.setupProgress ?? []} />
      </div>
    ) : activeThread.status === 'idle' && (activeThread.queuedCount ?? 0) === 0 ? (
      <ThreadIdleStarter activeThread={activeThread} />
    ) : (
      <ThreadChatView activeThread={activeThread} />
    );

  if (isThreadSwitching) {
    return (
      <div className="relative flex h-full min-w-0 flex-1 flex-col" data-testid="thread-switching">
        {threadBody}
        <div
          className="bg-background/40 pointer-events-none absolute inset-0 z-10 flex items-start justify-center pt-16"
          aria-hidden
        >
          <LoadingState fill={false} testId="thread-switching-spinner" />
        </div>
      </div>
    );
  }

  return <div className={cn('flex h-full min-w-0 flex-1 flex-col')}>{threadBody}</div>;
}
