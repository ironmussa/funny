import { Loader2, X } from 'lucide-react';
import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { PromptInput } from '@/components/PromptInput';
import { MessageStream, type MessageStreamHandle } from '@/components/thread/MessageStream';
import { ThreadPowerline } from '@/components/ThreadPowerline';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { api } from '@/lib/api';
import { statusConfig } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/app-store';
import { useProjectStore } from '@/stores/project-store';
import { deriveToolLists, useSettingsStore } from '@/stores/settings-store';
import { ThreadProvider } from '@/stores/thread-context';
import { useThreadStore, type ThreadWithMessages } from '@/stores/thread-store';

type OpenLightboxFn = (images: { src: string; alt: string }[], index: number) => void;

interface Props {
  threadId: string;
  onRemove?: () => void;
  onOpenLightbox?: OpenLightboxFn;
}

/** A single column that loads and streams a thread in real-time. */
export const ThreadColumn = memo(function ThreadColumn({
  threadId,
  onRemove,
  onOpenLightbox,
}: Props) {
  const { t } = useTranslation();
  const [thread, setThread] = useState<ThreadWithMessages | null>(null);
  const [loading, setLoading] = useState(true);
  const streamRef = useRef<MessageStreamHandle>(null);
  const projects = useProjectStore((s) => s.projects);

  const liveStatus = useThreadStore((s) => {
    for (const threads of Object.values(s.threadsByProject)) {
      const found = threads.find((th) => th.id === threadId);
      if (found) return found.status;
    }
    return null;
  });

  const onRemoveRef = useRef(onRemove);
  useEffect(() => {
    onRemoveRef.current = onRemove;
  }, [onRemove]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getThread(threadId, 50).then((result) => {
      if (cancelled) return;
      if (result.isOk()) {
        setThread(result.value as ThreadWithMessages);
      } else if (result.error.type === 'NOT_FOUND') {
        onRemoveRef.current?.();
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  const prevStatusRef = useRef(liveStatus);
  useEffect(() => {
    if (liveStatus === prevStatusRef.current) return;
    prevStatusRef.current = liveStatus;
    api.getThread(threadId, 50).then((result) => {
      if (result.isOk()) {
        setThread(result.value as ThreadWithMessages);
      } else if (result.error.type === 'NOT_FOUND') {
        onRemoveRef.current?.();
      }
    });
  }, [threadId, liveStatus]);

  const threadProjectId = thread?.projectId;
  const threadProject = useMemo(() => {
    if (!threadProjectId) return null;
    return projects.find((p) => p.id === threadProjectId) ?? null;
  }, [threadProjectId, projects]);
  const projectName = threadProject?.name ?? '';

  const [sending, setSending] = useState(false);

  const handleSend = useCallback(
    async (
      prompt: string,
      opts: {
        provider?: string;
        model: string;
        mode: string;
        fileReferences?: { path: string; type?: 'file' | 'folder' }[];
        symbolReferences?: {
          path: string;
          name: string;
          kind: string;
          line: number;
          endLine?: number;
        }[];
      },
      images?: any[],
    ) => {
      if (sending || !thread) return;
      setSending(true);
      streamRef.current?.scrollToBottom();
      startTransition(() => {
        useAppStore
          .getState()
          .appendOptimisticMessage(
            threadId,
            prompt,
            images,
            opts.model as any,
            opts.mode as any,
            opts.fileReferences,
          );
      });
      const { allowedTools, disallowedTools } = deriveToolLists(
        useSettingsStore.getState().toolPermissions,
      );
      const result = await api.sendMessage(
        threadId,
        prompt,
        {
          provider: opts.provider || undefined,
          model: opts.model || undefined,
          permissionMode: opts.mode || undefined,
          allowedTools,
          disallowedTools,
          fileReferences: opts.fileReferences,
          symbolReferences: opts.symbolReferences,
        },
        images,
      );
      if (result.isErr()) {
        const err = result.error;
        toast.error(
          err.type === 'INTERNAL'
            ? t('thread.sendFailed')
            : t('thread.sendFailedGeneric', { error: err.message }),
        );
      }
      setSending(false);
    },
    [sending, threadId, thread, t],
  );

  const handleStop = useCallback(async () => {
    await api.stopThread(threadId);
  }, [threadId]);

  const status = liveStatus ?? thread?.status ?? 'idle';
  const StatusIcon = statusConfig[status]?.icon ?? Loader2;
  const statusClass = statusConfig[status]?.className ?? '';

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center rounded-sm border border-border">
        <Loader2 className="icon-lg animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!thread) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center rounded-sm border border-border text-xs text-muted-foreground">
        {t('thread.notFound', 'Thread not found')}
      </div>
    );
  }

  const isRunning = status === 'running';

  return (
    <ThreadProvider threadId={threadId} source="live" liveThread={thread}>
      <div
        className="group/col flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-sm border border-border"
        data-testid={`grid-column-${threadId}`}
      >
        <div className="flex-shrink-0 border-b border-border bg-sidebar/50 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <StatusIcon className={cn('icon-sm shrink-0', statusClass)} />
            <span className="flex-1 truncate text-sm font-medium" title={thread.title}>
              {thread.title}
            </span>
            {onRemove && (
              <TooltipIconButton
                tooltip={t('live.removeFromGrid', 'Remove from grid')}
                onClick={onRemove}
                className="h-5 w-5 shrink-0 opacity-0 transition-opacity group-hover/col:opacity-100"
                data-testid={`grid-remove-${threadId}`}
              >
                <X className="icon-xs" />
              </TooltipIconButton>
            )}
          </div>
          <ThreadPowerline
            thread={thread}
            projectName={projectName}
            projectColor={threadProject?.color}
            className="mt-1"
            data-testid={`grid-column-powerline-${threadId}`}
          />
        </div>

        <MessageStream
          ref={streamRef}
          compact
          threadId={thread.id}
          status={status}
          messages={thread.messages ?? []}
          threadEvents={thread.threadEvents}
          compactionEvents={thread.compactionEvents}
          initInfo={thread.initInfo}
          resultInfo={thread.resultInfo}
          waitingReason={thread.waitingReason}
          pendingPermission={thread.pendingPermission}
          isExternal={thread.provider === 'external'}
          model={thread.model}
          permissionMode={thread.permissionMode}
          onSend={handleSend}
          onOpenLightbox={onOpenLightbox}
          className="min-h-0 flex-1"
          footer={
            <PromptInput
              onSubmit={handleSend}
              onStop={handleStop}
              loading={sending}
              running={isRunning}
              placeholder={t('thread.nextPrompt')}
            />
          }
        />
      </div>
    </ThreadProvider>
  );
});
