import { ArrowLeft } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import { lazy, Suspense, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { PromptInput } from '@/components/PromptInput';
import { StatusBadge } from '@/components/StatusBadge';
import { EMPTY_MESSAGES } from '@/components/thread/MemoizedMessageList';
import { MessageStream, type MessageStreamHandle } from '@/components/thread/MessageStream';
import { ThreadTitle } from '@/components/thread/ThreadAttachmentsBadge';
import { useThreadHandlers } from '@/components/thread/use-thread-handlers';
import { LoadingState } from '@/components/ui/loading-state';
import { useImageLightbox } from '@/hooks/use-image-lightbox';
import { useTodoSnapshots } from '@/hooks/use-todo-panel';
import { useAppStore } from '@/stores/app-store';
import {
  useCompactionEvents,
  useThreadEvents,
  useThreadMessages,
  useThreadSelector,
  type ThreadCore,
} from '@/stores/thread-context';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

// Reuse the desktop review pane; lazy-loaded so it stays out of the mobile
// first-paint bundle (mirrors how App.tsx lazy-loads it).
const ReviewPane = lazy(() =>
  import('@/components/ReviewPane').then((m) => ({ default: m.ReviewPane })),
);

interface Props {
  projectId: string;
  threadId: string;
  onBack: () => void;
}

export function ChatView({ projectId: _projectId, threadId, onBack }: Props) {
  const { t } = useTranslation();
  const selectThread = useAppStore((s) => s.selectThread);
  const reviewPaneOpen = useUIStore((s) => s.reviewPaneOpen);
  const setReviewPaneOpen = useUIStore((s) => s.setReviewPaneOpen);
  const activeThread = useThreadSelector((th) => th);
  const stableMessages = useThreadMessages();
  const stableThreadEvents = useThreadEvents();
  const stableCompactionEvents = useCompactionEvents();
  const loadOlderMessages = useThreadStore((s) => s.loadOlderMessages);
  const prefersReducedMotion = useReducedMotion();
  const { openLightbox, lightbox } = useImageLightbox();

  // Shared messaging pipeline — same hook ThreadChatView (desktop) uses, so
  // send/stop/permission/tool-respond behave identically across form factors.
  const streamRef = useRef<MessageStreamHandle>(null);
  const activeThreadRef = useRef<ThreadCore | null>(activeThread);
  activeThreadRef.current = activeThread;
  const sendingRef = useRef(false);
  const { sending, handleSend, handleStop, handlePermissionApproval, handleToolRespond } =
    useThreadHandlers({ activeThreadRef, sendingRef, streamRef });

  useEffect(() => {
    selectThread(threadId);
    return () => {
      selectThread(null);
    };
  }, [threadId, selectThread]);

  // The review pane is an in-place overlay on mobile, driven by the shared
  // `reviewPaneOpen` flag (the prompt-footer DiffStats chip flips it on). That
  // flag is persisted, so force it closed when entering/leaving a chat — we
  // never want to land directly in the review overlay.
  useEffect(() => {
    setReviewPaneOpen(false);
    return () => setReviewPaneOpen(false);
  }, [threadId, setReviewPaneOpen]);

  // Track which message/tool-call IDs existed when the thread was loaded, so
  // already-present items skip the entrance animation (matches desktop).
  const knownIdsRef = useRef<Set<string>>(new Set());
  const prevThreadIdRef = useRef<string | null>(null);
  if (activeThread?.id && activeThread.id !== prevThreadIdRef.current) {
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

  const isExternal = activeThread?.provider === 'external';
  const isRunning = activeThread?.status === 'running' || (activeThread?.queuedCount ?? 0) > 0;
  const hasMore = activeThread?.hasMore ?? false;
  const loadingMore = activeThread?.loadingMore ?? false;
  const totalMessages = activeThread?.totalMessages ?? 0;

  return (
    <>
      {lightbox}
      {reviewPaneOpen && activeThread && (
        <div
          className="bg-background fixed inset-0 z-50 flex flex-col"
          data-testid="mobile-review-overlay"
        >
          <header className="border-border flex h-14 shrink-0 items-center gap-3 border-b px-4">
            <button
              onClick={() => setReviewPaneOpen(false)}
              aria-label={t('common.back', 'Back')}
              className="hover:bg-accent -ml-1 rounded p-1"
              data-testid="mobile-review-back"
            >
              <ArrowLeft className="icon-lg" />
            </button>
            <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{t('review.title')}</h1>
          </header>
          <div className="min-h-0 flex-1 overflow-hidden">
            <Suspense fallback={<LoadingState testId="mobile-review-loading" />}>
              <ReviewPane />
            </Suspense>
          </div>
        </div>
      )}
      <header className="border-border flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <button
          onClick={onBack}
          aria-label={t('common.back', 'Back')}
          className="hover:bg-accent -ml-1 rounded p-1"
        >
          <ArrowLeft className="icon-lg" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold">
            {activeThread ? (
              <ThreadTitle
                as="span"
                title={activeThread.title}
                className="text-base font-semibold"
                containerClassName="max-w-full"
              />
            ) : (
              t('thread.loading', 'Loading...')
            )}
          </h1>
        </div>
        {activeThread && <StatusBadge status={activeThread.status} />}
      </header>

      {!activeThread ? (
        <LoadingState testId="mobile-chat-loading" />
      ) : (
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
          onSend={handleSend}
          onPermissionApproval={handlePermissionApproval}
          onToolRespond={handleToolRespond}
          pagination={{ hasMore, loadingMore, load: loadOlderMessages, total: totalMessages }}
          createdAt={activeThread.createdAt}
          snapshotMap={snapshotMap}
          knownIds={knownIdsRef.current}
          onOpenLightbox={openLightbox}
          prefersReducedMotion={prefersReducedMotion}
          footer={
            <PromptInput
              onSubmit={handleSend}
              onStop={handleStop}
              loading={sending}
              running={isRunning && !isExternal}
              placeholder={t('thread.nextPrompt')}
            />
          }
        />
      )}
    </>
  );
}
