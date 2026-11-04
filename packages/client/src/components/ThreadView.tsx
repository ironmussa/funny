import { FolderOpen, Rocket, Plus } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingState } from '@/components/ui/loading-state';
import { useProjects } from '@/data/projects/hooks';
import { useActiveThreadId } from '@/hooks/use-active-thread-id';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { useSandboxSetupSteps } from '@/hooks/use-sandbox-setup-steps';
import { runsInSandbox } from '@/lib/thread-variant';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/app-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadCore } from '@/stores/thread-context';
import { useUIStore } from '@/stores/ui-store';

import { NewThreadInput } from './thread/NewThreadInput';
import { ThreadChatView } from './thread/ThreadChatView';
import { ThreadIdleStarter } from './thread/ThreadIdleStarter';
import {
  ThreadPreparationView,
  type PreparationMessageMetadata,
} from './thread/ThreadPreparationView';

export interface ThreadViewProps {
  /** Called once the primary route has enough data to paint its real view. */
  onReady?: () => void;
}

export function ThreadView({ onReady }: ThreadViewProps = {}) {
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
  const hasProjects = useProjects().length > 0;
  const setAddProjectOpen = useAppStore((s) => s.setAddProjectOpen);
  // Prompt handed over by NewThreadInput so the conversation layout stays put
  // while the freshly created thread loads.
  const { pendingPrompt, pendingMetadata } =
    (useLocation().state as {
      pendingPrompt?: string;
      pendingMetadata?: PreparationMessageMetadata;
    } | null) ?? {};

  useEffect(() => {
    if (!activeThreadId || activeThread) onReady?.();
  }, [activeThread, activeThreadId, onReady]);

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
        <EmptyState
          icon={hasProjects ? Rocket : FolderOpen}
          title={hasProjects ? t('thread.selectOrCreate') : t('thread.addProjectFirst')}
          description={
            hasProjects ? t('thread.threadsRunParallel') : t('thread.addProjectDescription')
          }
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAddProjectOpen(true)}
              data-testid="thread-empty-add-project"
            >
              <Plus className="icon-sm" />
              {t('sidebar.addProject')}
            </Button>
          }
        />
      </div>
    );
  }

  if (!activeThread) {
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col">
        {pendingPrompt ? (
          <ThreadPreparationView
            prompt={pendingPrompt}
            metadata={pendingMetadata}
            projectId={selectedProjectId ?? undefined}
          />
        ) : (
          <LoadingState
            testId="thread-loading-placeholder"
            label={t('common.preparing', 'Preparing…')}
          />
        )}
      </div>
    );
  }

  const threadBody = <ThreadBody activeThread={activeThread} pendingMetadata={pendingMetadata} />;

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

function PreparingThread({
  activeThread,
  pendingMetadata,
}: {
  activeThread: NonNullable<ReturnType<typeof useThreadCore>>;
  pendingMetadata?: PreparationMessageMetadata;
}) {
  const message = preparationMessage(activeThread);
  const sandboxSteps = useSandboxSetupSteps(activeThread);
  return (
    <ThreadPreparationView
      prompt={message.content ?? activeThread.initialPrompt}
      projectId={activeThread.projectId}
      metadata={preparationMetadata(activeThread, message, pendingMetadata)}
      steps={sandboxSteps ?? activeThread.setupProgress ?? []}
    />
  );
}

type PreparationMessage = Partial<NonNullable<LoadedThread['lastUserMessage']>>;

function preparationMessage(activeThread: LoadedThread): PreparationMessage {
  return activeThread.lastUserMessage ?? {};
}

/** The persisted user message wins; thread defaults / pending metadata fill the gaps. */
function preparationMetadata(
  activeThread: LoadedThread,
  message: PreparationMessage,
  pendingMetadata?: PreparationMessageMetadata,
): PreparationMessageMetadata {
  return {
    model: message.model ?? activeThread.model,
    permissionMode: message.permissionMode ?? activeThread.permissionMode,
    effort: message.effort ?? pendingMetadata?.effort,
    timestamp: message.timestamp ?? activeThread.createdAt,
  };
}

type LoadedThread = NonNullable<ReturnType<typeof useThreadCore>>;
function ThreadBody({
  activeThread,
  pendingMetadata,
}: {
  activeThread: LoadedThread;
  pendingMetadata?: PreparationMessageMetadata;
}) {
  // A sandbox that failed before its agent ever started (no session) keeps
  // showing its setup steps, so the failed step and its error stay visible.
  const sandboxSetupFailed =
    runsInSandbox(activeThread) && activeThread.status === 'failed' && !activeThread.sessionId;
  if (activeThread.status === 'setting_up' || sandboxSetupFailed)
    return <PreparingThread activeThread={activeThread} pendingMetadata={pendingMetadata} />;
  if (activeThread.status === 'idle' && (activeThread.queuedCount ?? 0) === 0)
    return <ThreadIdleStarter activeThread={activeThread} />;
  return <ThreadChatView activeThread={activeThread} />;
}
