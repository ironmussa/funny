import { draggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { Loader2, X, GripVertical } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { type MessageStreamHandle } from '@/components/thread/MessageStream';
import { ProjectHeader } from '@/components/thread/ProjectHeader';
import { ThreadConversation } from '@/components/thread/ThreadConversation';
import { ThreadSearchBar } from '@/components/thread/ThreadSearchBar';
import { LoadingState } from '@/components/ui/loading-state';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { useThreadSearchState } from '@/hooks/use-thread-search';
import { createClientLogger } from '@/lib/client-logger';
import { setDashedDragPreview } from '@/lib/drag-preview';
import { getDisplayThreadStatus, statusConfig } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';
import { useRunnerStatusStore } from '@/stores/runner-status-store';
import { ThreadProvider } from '@/stores/thread-context';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

const log = createClientLogger('ThreadColumn');

type OpenLightboxFn = (images: { src: string; alt: string }[], index: number) => void;

interface Props {
  threadId: string;
  onRemove?: () => void;
  onOpenLightbox?: OpenLightboxFn;
}

/**
 * A single grid column. Owns the column chrome (header, drag handle, selection,
 * per-column search) and renders the shared `ThreadConversation` for the body,
 * so the messages / tool cards / session summary / follow-up input behave
 * exactly like the main thread view.
 */
export const ThreadColumn = memo(function ThreadColumn({
  threadId,
  onRemove,
  onOpenLightbox,
}: Props) {
  const { t } = useTranslation();
  const streamRef = useRef<MessageStreamHandle>(null);

  const columnRef = useRef<HTMLDivElement>(null);
  const dragHandleRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Grid selection: the grid's consolidated header action bar + the global
  // right pane act on the selected thread. Any pointer-down inside this column
  // selects it (capture phase, so inner handlers can't swallow it).
  const isSelected = useUIStore((s) => s.gridSelectedThreadId === threadId);
  const setGridSelectedThreadId = useUIStore((s) => s.setGridSelectedThreadId);
  const selectThisColumn = useCallback(() => {
    setGridSelectedThreadId(threadId);
  }, [setGridSelectedThreadId, threadId]);

  // Register for WS updates; fetch + unregister on unmount. The register
  // call anchors `threadDataById[threadId]` so the same map that backs the
  // right pane also keeps this column hydrated.
  const registerLiveThread = useThreadStore((s) => s.registerLiveThread);
  const unregisterLiveThread = useThreadStore((s) => s.unregisterLiveThread);

  useEffect(() => {
    registerLiveThread(threadId);
    return () => {
      unregisterLiveThread(threadId);
    };
  }, [threadId, registerLiveThread, unregisterLiveThread]);

  // Read directly from the unified payload map (this component body runs OUTSIDE
  // its own <ThreadProvider>). The conversation below reads the same thread via
  // context once it's mounted under the provider.
  const thread = useThreadStore((s) => s.threadDataById[threadId] ?? null);
  const loading = thread === null;

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

  // Per-column search: Ctrl+F opens search for the column under focus or
  // pointer hover. Mirrors ThreadChatView but scoped so only one column
  // claims the shortcut. stopImmediatePropagation prevents siblings from
  // also opening, and the browser's default find is preempted.
  const { searchOpen, setSearchOpen, handleSearchNavigate, handleSearchClose } =
    useThreadSearchState(streamRef, threadId);
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

  if (loading) {
    return (
      <div className="border-border flex min-h-0 flex-1 rounded-sm border">
        <LoadingState testId={`grid-column-loading-${threadId}`} />
      </div>
    );
  }

  if (!thread) {
    return (
      <div className="border-border text-muted-foreground flex min-h-0 flex-1 items-center justify-center rounded-sm border text-xs">
        {t('thread.notFound', 'Thread not found')}
      </div>
    );
  }

  return (
    <ThreadProvider threadId={threadId}>
      <div
        ref={columnRef}
        className={cn(
          'group/col relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-sm border border-border',
          isDragging && 'opacity-50',
          isSelected && 'border-primary ring-primary/40 ring-1',
        )}
        data-testid={`grid-column-${threadId}`}
        data-selected={isSelected ? 'true' : undefined}
        onPointerDownCapture={selectThisColumn}
        onPointerEnter={() => {
          isHoveredRef.current = true;
        }}
        onPointerLeave={() => {
          isHoveredRef.current = false;
        }}
      >
        <div ref={dragHandleRef} className="shrink-0 cursor-grab active:cursor-grabbing">
          <ProjectHeader
            hideActions
            hideFiles
            hideTests
            hideStartup
            hideTerminal
            hideTimeline
            leading={
              <>
                <GripVertical className="icon-xs text-muted-foreground shrink-0" />
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
          className="border-border bg-popover absolute top-9 right-2 z-30 gap-1.5 rounded-md border px-2 py-1.5 shadow-md"
        />

        <ThreadConversation
          streamRef={streamRef}
          onOpenLightbox={onOpenLightbox}
          className="min-h-0 flex-1"
        />
      </div>
    </ThreadProvider>
  );
});
