import { draggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { Loader2, X, GripVertical } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { PromptInput } from '@/components/PromptInput';
import { EMPTY_MESSAGES } from '@/components/thread/MemoizedMessageList';
import { MessageStream, type MessageStreamHandle } from '@/components/thread/MessageStream';
import { ProjectHeader } from '@/components/thread/ProjectHeader';
import { ThreadSearchBar } from '@/components/thread/ThreadSearchBar';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { useThreadSearchState } from '@/hooks/use-thread-search';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { setDashedDragPreview } from '@/lib/drag-preview';
import { getDisplayThreadStatus, statusConfig } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/app-store';
import { useRunnerStatusStore } from '@/stores/runner-status-store';
import { deriveToolLists, useSettingsStore } from '@/stores/settings-store';
import { ThreadProvider } from '@/stores/thread-context';
import { useThreadStore } from '@/stores/thread-store';

const log = createClientLogger('ThreadColumn');

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
  const prefersReducedMotion = useReducedMotion();

  const columnRef = useRef<HTMLDivElement>(null);
  const dragHandleRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Register for WS updates; fetch + unregister on unmount. The register
  // call anchors `threadDataById[threadId]` so the same map that backs the
  // right pane also keeps this column hydrated.
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

  // Read directly from the unified payload map. WS handlers patch it in
  // place; selecting this thread in the right pane points `activeThread`
  // at the same entry.
  const thread = useThreadStore((s) => s.threadDataById[threadId] ?? null);
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
      element: handle,
      getInitialData: () => ({
        type: 'grid-thread',
        threadId,
      }),
      onGenerateDragPreview: ({ nativeSetDragImage }) =>
        setDashedDragPreview({ nativeSetDragImage, source: el }),
      onDragStart: () => setIsDragging(true),
      onDrop: () => setIsDragging(false),
    });
  }, [threadId, loading]);

  const [sending, setSending] = useState(false);

  const handleSend = useCallback(
    async (
      prompt: string,
      opts: {
        provider?: string;
        model: string;
        mode: string;
        effort?: string;
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
            opts.effort as any,
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
          effort: opts.effort || undefined,
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

  // Per-column search: Ctrl+F opens search for the column under focus or
  // pointer hover. Mirrors ThreadChatView but scoped so only one column
  // claims the shortcut. stopImmediatePropagation prevents siblings from
  // also opening, and the browser's default find is preempted.
  const { searchOpen, setSearchOpen, handleSearchNavigate, handleSearchClose } =
    useThreadSearchState(streamRef);
  const isHoveredRef = useRef(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.metaKey || e.altKey) return;
      if (e.key !== 'f' && e.key !== 'F') return;
      const target = e.target as Element | null;
      if (target && target.closest('.xterm')) return;
      const root = columnRef.current;
      if (!root) return;
      const focusInside = document.activeElement ? root.contains(document.activeElement) : false;
      if (!focusInside && !isHoveredRef.current) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      log.info({ threadId }, 'shortcut.grid_thread_search');
      setSearchOpen(true);
      const input = root.querySelector<HTMLInputElement>(
        `[data-testid="grid-search-${threadId}-input"]`,
      );
      if (input) requestAnimationFrame(() => input.focus());
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [threadId, setSearchOpen]);

  const runnerStatus = useRunnerStatusStore((s) => s.status);
  const status = getDisplayThreadStatus(thread?.status ?? 'idle', runnerStatus);
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
    <ThreadProvider threadId={threadId}>
      <div
        ref={columnRef}
        className={cn(
          'group/col relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-sm border border-border',
          isDragging && 'opacity-50',
        )}
        data-testid={`grid-column-${threadId}`}
        onPointerEnter={() => {
          isHoveredRef.current = true;
        }}
        onPointerLeave={() => {
          isHoveredRef.current = false;
        }}
      >
        <div ref={dragHandleRef} className="flex-shrink-0 cursor-grab active:cursor-grabbing">
          <ProjectHeader
            hideFiles
            hideTests
            hideStartup
            hideTerminal
            hideTimeline
            leading={
              <>
                <GripVertical className="icon-xs shrink-0 text-muted-foreground" />
                <StatusIcon className={cn('icon-sm shrink-0', statusClass)} />
              </>
            }
            trailing={
              onRemove ? (
                <TooltipIconButton
                  tooltip={t('live.removeFromGrid', 'Remove from grid')}
                  onClick={onRemove}
                  className="size-5 shrink-0 opacity-0 transition-opacity group-hover/col:opacity-100"
                  data-testid={`grid-remove-${threadId}`}
                >
                  <X className="icon-xs" />
                </TooltipIconButton>
              ) : undefined
            }
          />
        </div>

        <ThreadSearchBar
          threadId={threadId}
          open={searchOpen}
          onClose={handleSearchClose}
          onNavigateToMessage={handleSearchNavigate}
          testIdPrefix={`grid-search-${threadId}`}
          className="absolute right-2 top-9 z-30 gap-1.5 rounded-md border border-border bg-popover px-2 py-1.5 shadow-md"
        />

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
