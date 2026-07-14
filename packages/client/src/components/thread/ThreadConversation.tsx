import { DEFAULT_FOLLOW_UP_MODE } from '@funny/shared/models';
import { useReducedMotion } from 'motion/react';
import { useMemo, useRef, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { PromptInput } from '@/components/PromptInput';
import { EMPTY_MESSAGES } from '@/components/thread/MemoizedMessageList.constants';
import { MessageStream, type MessageStreamHandle } from '@/components/thread/MessageStream';
import { useThreadCheckpoints } from '@/components/thread/use-thread-checkpoints';
import { useThreadHandlers } from '@/components/thread/use-thread-handlers';
import { useImageLightbox } from '@/hooks/use-image-lightbox';
import { useTodoSnapshots } from '@/hooks/use-todo-panel';
import { sessionChangesFromEvents } from '@/lib/session-changes-from-events';
import {
  canDoGitOps,
  canForkAndRewindCode,
  canRewindCode,
  canSteerShare,
  isReadOnlyShare,
  supportsCodeRewind,
} from '@/lib/thread-variant';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth-store';
import { useProjectStore } from '@/stores/project-store';
import { useReviewPaneStore } from '@/stores/review-pane-store';
import {
  useCompactionEvents,
  useThreadCore,
  useThreadEvents,
  useThreadMessages,
} from '@/stores/thread-context';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

type OpenLightboxFn = (images: { src: string; alt: string }[], index: number) => void;

interface ThreadConversationProps {
  /** Shared stream handle (the host uses it for the timeline / scroll). */
  streamRef: RefObject<MessageStreamHandle | null>;
  /** Host-rendered search bar — positioning + Ctrl+F scope differ per host. */
  searchBar?: ReactNode;
  /** Shared lightbox opener. When omitted the component uses its own. */
  onOpenLightbox?: OpenLightboxFn;
  /**
   * Wire older-message pagination. The store paginates the globally-active
   * thread, so only the main view (whose context thread IS the active thread)
   * enables it; the grid omits it.
   */
  enablePagination?: boolean;
  /** Notified as the top-most visible message changes (for the timeline). */
  onVisibleMessageChange?: (id: string | null) => void;
  className?: string;
}

/**
 * The thread conversation column — the single source of truth for rendering a
 * thread's messages, tool cards, session-changes summary, and follow-up input.
 *
 * Shared verbatim by the main thread view (`ThreadChatView`) and each grid
 * column (`ThreadColumn`) so both behave identically. Reads the thread from
 * `ThreadProvider` context, so the caller just renders it under the right
 * provider; all messaging / checkpoint handlers are ref-scoped to that thread,
 * so multiple instances (grid columns) never interfere.
 */
export function ThreadConversation({
  streamRef,
  searchBar,
  onOpenLightbox,
  enablePagination = false,
  onVisibleMessageChange,
  className,
}: ThreadConversationProps) {
  const { t } = useTranslation();
  const prefersReducedMotion = useReducedMotion();
  const selfUserId = useAuthStore((s) => s.user?.id ?? null);

  const activeThread = useThreadCore();
  const stableMessages = useThreadMessages();
  const stableThreadEvents = useThreadEvents();
  const stableCompactionEvents = useCompactionEvents();
  const loadOlderMessages = useThreadStore((s) => s.loadOlderMessages);
  const loadNewerMessages = useThreadStore((s) => s.loadNewerMessages);
  const refreshAfterRevert = useReviewPaneStore((s) => s.notifyDirty);

  // A sharee (viewing a thread they don't own) is read-only UNLESS their grant
  // level is `steer` — mirrors the server's requireThreadSteer gate.
  const readOnlyShare =
    isReadOnlyShare(activeThread, selfUserId) && !canSteerShare(activeThread, selfUserId);

  const setPromptRef = useRef<((text: string) => void) | null>(null);
  const activeThreadRef = useRef(activeThread);
  activeThreadRef.current = activeThread;
  const sendingRef = useRef(false);

  const {
    sending,
    handleSend,
    handleStop,
    handlePermissionApproval,
    handlePermissionDecision,
    handleToolRespond,
  } = useThreadHandlers({ activeThreadRef, sendingRef, streamRef });
  const { handleFork, handleRewind, handleForkAndRewind, forkingMessageId } = useThreadCheckpoints({
    activeThreadRef,
  });

  // Track which message/tool-call IDs existed when the thread was loaded.
  const knownIdsRef = useRef<Set<string> | null>(null);
  if (knownIdsRef.current === null) knownIdsRef.current = new Set();
  const prevThreadIdRef = useRef<string | null>(null);
  if (activeThread && activeThread.id !== prevThreadIdRef.current) {
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
  const snapshotMapRef = useRef<Map<string, number> | null>(null);
  if (snapshotMapRef.current === null) snapshotMapRef.current = new Map();
  const snapshotMap = useMemo(() => {
    const next = new Map<string, number>();
    snapshots.forEach((s, i) => next.set(s.toolCallId, i));
    const prev = snapshotMapRef.current!;
    if (prev.size === next.size && [...next].every(([k, v]) => prev.get(k) === v)) {
      return prev;
    }
    snapshotMapRef.current = next;
    return next;
  }, [snapshots]);

  const internalLightbox = useImageLightbox();
  const openLightbox = onOpenLightbox ?? internalLightbox.openLightbox;

  // Per-session changed-files summaries: replayed verbatim from the frozen
  // `changed_files_summary` thread event at the end of each session. Git-capable,
  // non-external threads only; a running session has no event yet → no card.
  const isExternal = activeThread?.provider === 'external';
  const gitCapable = !!activeThread && canDoGitOps(activeThread) && !isExternal;
  const sessionChanges = useMemo(
    () => (gitCapable ? sessionChangesFromEvents(stableThreadEvents) : undefined),
    [gitCapable, stableThreadEvents],
  );

  if (!activeThread) return null;

  const uiQueuedCount = activeThread.queuedCount ?? 0;
  const isRunning = activeThread.status === 'running' || uiQueuedCount > 0;
  const currentProject = useProjectStore
    .getState()
    .projects.find((p) => p.id === activeThread.projectId);
  const followUpMode = currentProject?.followUpMode || DEFAULT_FOLLOW_UP_MODE;
  const isQueueMode = followUpMode === 'queue';
  const gitOps = canDoGitOps(activeThread);

  return (
    <div className={cn('relative flex min-h-0 min-w-0 flex-1 flex-col', className)}>
      {searchBar}
      <MessageStream
        ref={streamRef}
        threadId={activeThread.id}
        status={activeThread.status}
        messages={stableMessages ?? EMPTY_MESSAGES}
        lastUserMessage={activeThread.lastUserMessage}
        leadingUserMessage={activeThread.leadingUserMessage}
        threadEvents={stableThreadEvents}
        compactionEvents={stableCompactionEvents}
        initInfo={activeThread.initInfo}
        resultInfo={activeThread.resultInfo}
        waitingReason={activeThread.waitingReason}
        pendingPermission={activeThread.pendingPermission}
        pendingPermissionRequest={activeThread.pendingPermissionRequest}
        permissionApprovalCapability={activeThread.permissionApprovalCapability}
        permissionRecoveryReason={
          activeThread.permissionRecoveryReason ??
          (activeThread.contextRecoveryReason === 'permission-request-expired'
            ? 'runner_lost'
            : undefined)
        }
        isExternal={isExternal}
        model={activeThread.model}
        permissionMode={activeThread.permissionMode}
        sessionChanges={sessionChanges}
        onSessionReverted={() => refreshAfterRevert(activeThread.id)}
        onSend={handleSend}
        onPermissionApproval={handlePermissionApproval}
        onPermissionDecision={handlePermissionDecision}
        onToolRespond={handleToolRespond}
        onFork={gitOps ? handleFork : undefined}
        onRewind={gitOps ? handleRewind : undefined}
        onForkAndRewind={
          gitOps && canForkAndRewindCode(activeThread) ? handleForkAndRewind : undefined
        }
        forkingMessageId={forkingMessageId}
        rewindDisabled={!canRewindCode(activeThread)}
        rewindDisabledReason={
          !supportsCodeRewind(activeThread)
            ? t(
                'thread.rewindNotSupportedProvider',
                'Rewind is only available for Claude and Codex threads',
              )
            : t('thread.rewindNoCheckpoints', 'This thread was started without file checkpointing')
        }
        pagination={
          enablePagination
            ? {
                hasMore: activeThread.hasMore ?? false,
                hasMoreAfter: activeThread.hasMoreAfter ?? false,
                loadingMore: activeThread.loadingMore ?? false,
                load: loadOlderMessages,
                loadAfter: loadNewerMessages,
                total: activeThread.totalMessages ?? 0,
                windowStart: activeThread.windowStart ?? 0,
              }
            : undefined
        }
        createdAt={activeThread.createdAt}
        snapshotMap={snapshotMap}
        knownIds={knownIdsRef.current}
        onOpenLightbox={openLightbox}
        onVisibleMessageChange={onVisibleMessageChange}
        prefersReducedMotion={prefersReducedMotion}
        className="min-h-0 flex-1"
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
      {!onOpenLightbox && internalLightbox.lightbox}
    </div>
  );
}
