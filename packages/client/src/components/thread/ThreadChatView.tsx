import { DEFAULT_FOLLOW_UP_MODE } from '@funny/shared/models';
import { useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PipelineProgressBanner } from '@/components/PipelineProgressBanner';
import { PromptInput } from '@/components/PromptInput';
import { EMPTY_MESSAGES } from '@/components/thread/MemoizedMessageList';
import { MessageStream, type MessageStreamHandle } from '@/components/thread/MessageStream';
import { PromptTimeline } from '@/components/thread/PromptTimeline';
import { ThreadSearchBar } from '@/components/thread/ThreadSearchBar';
import { useImageLightbox } from '@/hooks/use-image-lightbox';
import { useThreadSearchState } from '@/hooks/use-thread-search';
import { useTodoSnapshots } from '@/hooks/use-todo-panel';
import { sessionChangesFromEvents } from '@/lib/session-changes-from-events';
import { canDoGitOps, canSteerShare, isReadOnlyShare } from '@/lib/thread-variant';
import { useAuthStore } from '@/stores/auth-store';
import { useProjectStore } from '@/stores/project-store';
import { useReviewPaneStore } from '@/stores/review-pane-store';
import {
  useCompactionEvents,
  useThreadEvents,
  useThreadMessages,
  type ThreadCore,
} from '@/stores/thread-context';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

import { useThreadCheckpoints } from './use-thread-checkpoints';
import { useThreadHandlers } from './use-thread-handlers';

type ActiveThread = ThreadCore;

interface Props {
  activeThread: ActiveThread;
}

export function ThreadChatView({ activeThread }: Props) {
  const { t } = useTranslation();
  const selfUserId = useAuthStore((s) => s.user?.id ?? null);
  // A sharee (viewing a thread they don't own) is read-only UNLESS their grant
  // level is `steer` — a steer sharee may send follow-ups (thread-sharing-steer).
  // Mirrors the server's requireThreadSteer gate: only a `view` sharee is locked
  // out of the PromptInput.
  const readOnlyShare =
    isReadOnlyShare(activeThread, selfUserId) && !canSteerShare(activeThread, selfUserId);
  const stableMessages = useThreadMessages();
  const stableThreadEvents = useThreadEvents();
  const stableCompactionEvents = useCompactionEvents();
  const timelineVisible = useUIStore((s) => s.timelineVisible);
  const loadOlderMessages = useThreadStore((s) => s.loadOlderMessages);
  const hasMore = activeThread.hasMore ?? false;
  const loadingMore = activeThread.loadingMore ?? false;
  const totalMessages = activeThread.totalMessages ?? 0;
  const prefersReducedMotion = useReducedMotion();

  const streamRef = useRef<MessageStreamHandle>(null);
  const [visibleMessageId, setVisibleMessageId] = useState<string | null>(null);
  const { openLightbox, lightbox } = useImageLightbox();

  const setPromptRef = useRef<((text: string) => void) | null>(null);
  const activeThreadRef = useRef<ActiveThread | null>(activeThread);
  activeThreadRef.current = activeThread;
  const sendingRef = useRef(false);

  const handlers = useThreadHandlers({
    activeThreadRef,
    sendingRef,
    streamRef,
  });
  const { sending, handleSend, handleStop, handlePermissionApproval, handleToolRespond } = handlers;
  const { handleFork, handleRewind, handleForkAndRewind, forkingMessageId } = useThreadCheckpoints({
    activeThreadRef,
  });

  // Track which message/tool-call IDs existed when the thread was loaded.
  const knownIdsRef = useRef<Set<string>>(new Set());
  const prevThreadIdRef = useRef<string | null>(null);
  if (activeThread.id !== prevThreadIdRef.current) {
    prevThreadIdRef.current = activeThread.id;
    const ids = new Set<string>();
    if (stableMessages) {
      for (const m of stableMessages) {
        ids.add(m.id);
        if (m.toolCalls) for (const tc of m.toolCalls) ids.add(tc.id);
      }
    }
    knownIdsRef.current = ids;
  }

  const snapshots = useTodoSnapshots();
  const snapshotMapRef = useRef(new Map<string, number>());
  const snapshotMap = useMemo(() => {
    const next = new Map<string, number>();
    snapshots.forEach((s, i) => next.set(s.toolCallId, i));
    const prev = snapshotMapRef.current;
    if (prev.size === next.size && [...next].every(([k, v]) => prev.get(k) === v)) {
      return prev;
    }
    snapshotMapRef.current = next;
    return next;
  }, [snapshots]);

  const { searchOpen, setSearchOpen, handleSearchNavigate, handleSearchClose } =
    useThreadSearchState(streamRef, activeThread.id);

  // Search handoff from the list/board views: arriving at a thread via a
  // search-result click opens the in-thread search pre-filled with that
  // query. ThreadSearchBar consumes (and clears) the pending entry itself.
  const pendingThreadSearch = useUIStore((s) => s.pendingThreadSearch);
  useEffect(() => {
    if (pendingThreadSearch && pendingThreadSearch.threadId === activeThread.id) {
      setSearchOpen(true);
    }
  }, [pendingThreadSearch, activeThread.id, setSearchOpen]);

  // Global Ctrl+F opens the per-thread search in the main chat view. Scoped
  // to the active thread; the grid view has its own per-column handler.
  useEffect(() => {
    if (!activeThread.id) return;
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.metaKey || e.altKey) return;
      if (e.key !== 'f' && e.key !== 'F') return;
      // Don't hijack Ctrl+F when focus is inside a terminal — the
      // terminal owns this shortcut and shows its own search overlay.
      const target = e.target as Element | null;
      if (target && target.closest('.xterm')) return;
      e.preventDefault();
      e.stopPropagation();
      setSearchOpen(true);
      const input = document.querySelector<HTMLInputElement>('[data-testid="thread-search-input"]');
      if (input) requestAnimationFrame(() => input.focus());
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [activeThread.id, setSearchOpen]);

  const uiQueuedCount = activeThread.queuedCount ?? 0;
  const isRunning = activeThread.status === 'running' || uiQueuedCount > 0;
  const isExternal = activeThread.provider === 'external';
  const currentProject = useProjectStore
    .getState()
    .projects.find((p) => p.id === activeThread.projectId);
  const followUpMode = currentProject?.followUpMode || DEFAULT_FOLLOW_UP_MODE;
  const isQueueMode = followUpMode === 'queue';

  // Per-session changed-files summaries: each completed session carries a frozen
  // summary at its end. The runtime snapshots it when the agent run finishes and
  // persists it as a `changed_files_summary` thread event, so it's replayed
  // verbatim here — only at the end of a session, never recomputed from the live
  // working tree on refresh. A running session has no event yet → no card.
  // Git-capable, non-external threads only.
  const gitCapable = canDoGitOps(activeThread) && !isExternal;
  const sessionChanges = useMemo(
    () => (gitCapable ? sessionChangesFromEvents(stableThreadEvents) : undefined),
    [gitCapable, stableThreadEvents],
  );
  // After an Undo reverts a session's files, refresh the live diff/review views
  // (the historical summary card itself stays — it's a record of the session).
  const refreshAfterRevert = useReviewPaneStore((s) => s.notifyDirty);

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col">
      {activeThread.id && <PipelineProgressBanner threadId={activeThread.id} />}
      <div className="thread-container flex min-h-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <ThreadSearchBar
            threadId={activeThread.id}
            open={searchOpen}
            onClose={handleSearchClose}
            onNavigateToMessage={handleSearchNavigate}
          />
          <MessageStream
            ref={streamRef}
            threadId={activeThread.id}
            status={activeThread.status}
            messages={stableMessages ?? EMPTY_MESSAGES}
            threadEvents={stableThreadEvents}
            compactionEvents={stableCompactionEvents}
            initInfo={activeThread.initInfo}
            resultInfo={activeThread.resultInfo}
            waitingReason={activeThread.waitingReason}
            pendingPermission={activeThread.pendingPermission}
            isExternal={isExternal}
            model={activeThread.model}
            permissionMode={activeThread.permissionMode}
            sessionChanges={sessionChanges}
            onSessionReverted={() => refreshAfterRevert(activeThread.id)}
            onSend={handleSend}
            onPermissionApproval={handlePermissionApproval}
            onToolRespond={handleToolRespond}
            onFork={canDoGitOps(activeThread) ? handleFork : undefined}
            onRewind={canDoGitOps(activeThread) ? handleRewind : undefined}
            onForkAndRewind={canDoGitOps(activeThread) ? handleForkAndRewind : undefined}
            forkingMessageId={forkingMessageId}
            rewindDisabled={
              activeThread.provider !== 'claude' || !(activeThread as any).fileCheckpointingEnabled
            }
            rewindDisabledReason={
              activeThread.provider !== 'claude'
                ? t(
                    'thread.rewindNotSupportedProvider',
                    'Rewind is only available for Claude threads',
                  )
                : t(
                    'thread.rewindNoCheckpoints',
                    'This thread was started without file checkpointing',
                  )
            }
            pagination={{ hasMore, loadingMore, load: loadOlderMessages, total: totalMessages }}
            createdAt={activeThread.createdAt}
            snapshotMap={snapshotMap}
            knownIds={knownIdsRef.current}
            onOpenLightbox={openLightbox}
            onVisibleMessageChange={setVisibleMessageId}
            prefersReducedMotion={prefersReducedMotion}
            footer={
              readOnlyShare ? (
                <div
                  className="text-muted-foreground border-border border-t px-4 py-3 text-center text-xs"
                  data-testid="thread-readonly-share-notice"
                >
                  {t(
                    'thread.readOnlyShare',
                    "You're viewing a shared thread — read-only. Only the owner can send messages.",
                  )}{' '}
                  <button
                    type="button"
                    className="text-status-info hover:underline"
                    onClick={() => useUIStore.getState().setCommentsPaneOpen(true)}
                    data-testid="thread-readonly-open-comments"
                  >
                    {t('thread.readOnlyShareComment', 'Open Comments to leave a note.')}
                  </button>
                </div>
              ) : activeThread.waitingReason === 'plan' ? null : (
                <PromptInput
                  onSubmit={handleSend}
                  onStop={handleStop}
                  loading={sending}
                  running={isRunning && !isExternal}
                  isQueueMode={isQueueMode}
                  queuedCount={activeThread.queuedCount ?? 0}
                  queuedNextMessage={activeThread.queuedNextMessage}
                  setPromptRef={setPromptRef}
                  placeholder={t('thread.nextPrompt')}
                />
              )
            }
          />
        </div>
        {timelineVisible && stableMessages && stableMessages.length > 0 && (
          <PromptTimeline
            messages={stableMessages}
            activeMessageId={
              visibleMessageId ??
              activeThread.lastUserMessage?.id ??
              stableMessages.filter((m) => m.role === 'user' && m.content?.trim()).at(-1)?.id
            }
            threadStatus={activeThread.status}
            messagesScrollRef={{ current: streamRef.current?.scrollViewport ?? null }}
            onScrollToMessage={(msgId, toolCallId) => {
              const targetId = toolCallId || msgId;
              const selector = toolCallId
                ? `[data-tool-call-id="${toolCallId}"]`
                : `[data-user-msg="${msgId}"]`;
              const viewport = streamRef.current?.scrollViewport;
              const el = viewport?.querySelector(selector);
              if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              } else {
                streamRef.current?.expandToItem(targetId);
                requestAnimationFrame(() => {
                  const el2 = streamRef.current?.scrollViewport?.querySelector(selector);
                  if (el2) el2.scrollIntoView({ behavior: 'smooth', block: 'center' });
                });
              }
            }}
          />
        )}
      </div>
      {lightbox}
    </div>
  );
}
