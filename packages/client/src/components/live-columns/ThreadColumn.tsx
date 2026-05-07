import { draggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { setCustomNativeDragPreview } from '@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview';
import { Loader2, X, GripVertical } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { PromptInput } from '@/components/PromptInput';
import { EMPTY_MESSAGES } from '@/components/thread/MemoizedMessageList';
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
import { useThreadStore } from '@/stores/thread-store';

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
  const streamRef = useRef<MessageStreamHandle>(null);
  const projects = useProjectStore((s) => s.projects);
  const prefersReducedMotion = useReducedMotion();

  const columnRef = useRef<HTMLDivElement>(null);
  const dragHandleRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Register for live WS updates; fetch + unregister on unmount
  const registerLiveThread = useThreadStore((s) => s.registerLiveThread);
  const unregisterLiveThread = useThreadStore((s) => s.unregisterLiveThread);

  const onRemoveRef = useRef(onRemove);
  useEffect(() => {
    onRemoveRef.current = onRemove;
  }, [onRemove]);

  useEffect(() => {
    registerLiveThread(threadId);
    return () => {
      unregisterLiveThread(threadId);
    };
  }, [threadId, registerLiveThread, unregisterLiveThread]);

  // Subscribe to live thread data pushed by WS handlers
  const thread = useThreadStore((s) => s.liveThreads[threadId] ?? null);
  const loading = thread === null;

  // Track which message/tool-call IDs existed when the thread was loaded.
  const knownIdsRef = useRef<Set<string>>(new Set());
  const prevThreadIdRef = useRef<string | null>(null);
  if (thread?.id && thread.id !== prevThreadIdRef.current) {
    prevThreadIdRef.current = thread.id;
    const ids = new Set<string>();
    if (thread.messages) {
      for (const m of thread.messages) {
        ids.add(m.id);
        if (m.toolCalls) for (const tc of m.toolCalls) ids.add(tc.id);
      }
    }
    knownIdsRef.current = ids;
  }

  useEffect(() => {
    const el = columnRef.current;
    const handle = dragHandleRef.current;
    if (!el || !handle) return;
    return draggable({
      element: el,
      dragHandle: handle,
      getInitialData: () => ({
        type: 'grid-thread',
        threadId,
      }),
      onGenerateDragPreview: ({ nativeSetDragImage }) => {
        setCustomNativeDragPreview({
          nativeSetDragImage,
          getOffset: () => ({ x: 16, y: 16 }),
          render: ({ container }) => {
            const rect = el.getBoundingClientRect();
            const preview = document.createElement('div');
            preview.style.width = `${rect.width}px`;
            preview.style.height = `${rect.height}px`;
            preview.style.borderRadius = '8px';
            preview.style.border = '2px dashed hsl(var(--primary))';
            preview.style.background = 'hsl(var(--primary) / 0.05)';
            container.appendChild(preview);
          },
        });
      },
      onDragStart: () => setIsDragging(true),
      onDrop: () => setIsDragging(false),
    });
  }, [threadId, loading]);

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

  const status = thread?.status ?? 'idle';
  const StatusIcon = statusConfig[status]?.icon ?? Loader2;
  const statusClass = statusConfig[status]?.className ?? '';

  const threadOverride = useMemo(
    () => ({
      provider: thread?.provider,
      model: thread?.model,
      permissionMode: thread?.permissionMode,
      branch: thread?.branch,
      baseBranch: thread?.baseBranch,
      worktreePath: thread?.worktreePath,
      contextUsage: thread?.contextUsage,
      queuedCount: thread?.queuedCount,
      projectId: thread?.projectId,
    }),
    [
      thread?.provider,
      thread?.model,
      thread?.permissionMode,
      thread?.branch,
      thread?.baseBranch,
      thread?.worktreePath,
      thread?.contextUsage,
      thread?.queuedCount,
      thread?.projectId,
    ],
  );

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
        ref={columnRef}
        className={cn(
          'group/col flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-sm border border-border',
          isDragging && 'opacity-50',
        )}
        data-testid={`grid-column-${threadId}`}
      >
        <div
          ref={dragHandleRef}
          className="flex-shrink-0 cursor-grab select-none border-b border-border bg-sidebar/50 px-3 py-2 transition-colors hover:bg-sidebar/80 active:cursor-grabbing"
        >
          <div className="flex min-w-0 items-center gap-2">
            <GripVertical className="icon-xs shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing" />
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
          threadId={thread.id}
          status={status}
          messages={thread.messages ?? EMPTY_MESSAGES}
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
          knownIds={knownIdsRef.current}
          prefersReducedMotion={prefersReducedMotion}
          className="min-h-0 flex-1"
          footer={
            <PromptInput
              onSubmit={handleSend}
              onStop={handleStop}
              loading={sending}
              running={isRunning}
              projectId={thread.projectId}
              placeholder={t('thread.nextPrompt')}
              threadOverride={threadOverride}
            />
          }
        />
      </div>
    </ThreadProvider>
  );
});
