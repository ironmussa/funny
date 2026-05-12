import { DEFAULT_FOLLOW_UP_MODE } from '@funny/shared/models';
import { useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { FollowUpModeDialog } from '@/components/FollowUpModeDialog';
import { PipelineProgressBanner } from '@/components/PipelineProgressBanner';
import { PromptInput } from '@/components/PromptInput';
import { EMPTY_MESSAGES } from '@/components/thread/MemoizedMessageList';
import { MessageStream, type MessageStreamHandle } from '@/components/thread/MessageStream';
import { ProjectHeader } from '@/components/thread/ProjectHeader';
import { PromptTimeline } from '@/components/thread/PromptTimeline';
import { ThreadSearchBar } from '@/components/thread/ThreadSearchBar';
import { useImageLightbox } from '@/hooks/use-image-lightbox';
import { useTodoSnapshots } from '@/hooks/use-todo-panel';
import { useProjectStore } from '@/stores/project-store';
import {
  useCompactionEvents,
  useThreadEvents,
  useThreadMessages,
  type ThreadCore,
} from '@/stores/thread-context';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

import { useThreadHandlers, type PendingSend } from './use-thread-handlers';

type ActiveThread = ThreadCore;

function useThreadSearch(
  activeThreadId: string | null,
  streamRef: RefObject<MessageStreamHandle | null>,
) {
  const [searchOpen, setSearchOpen] = useState(false);
  const highlightedMsgRef = useRef<string | null>(null);
  const highlightedQueryRef = useRef<string>('');

  useEffect(() => {
    if (!activeThreadId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && e.key === 'f') {
        // Don't hijack Ctrl+F when focus is inside a terminal — the
        // terminal owns this shortcut and shows its own search overlay.
        const target = e.target as Element | null;
        if (target && target.closest('.xterm')) return;
        e.preventDefault();
        e.stopPropagation();
        setSearchOpen(true);
        const input = document.querySelector<HTMLInputElement>(
          '[data-testid="thread-search-input"]',
        );
        if (input) requestAnimationFrame(() => input.focus());
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [activeThreadId]);

  const clearSearchHighlights = useCallback(() => {
    const viewport = streamRef.current?.scrollViewport;
    if (!viewport) return;
    viewport.querySelectorAll('mark[data-search-hl]').forEach((mark) => {
      const parent = mark.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
        parent.normalize();
      }
    });
  }, [streamRef]);

  const highlightTextInElement = useCallback((root: Element, query: string) => {
    if (!query) return;
    const queryLower = query.toLowerCase();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        // Skip text already inside a search mark to prevent nested re-highlighting.
        let p: Node | null = node.parentNode;
        while (p && p !== root) {
          if (p instanceof Element && p.hasAttribute('data-search-hl')) {
            return NodeFilter.FILTER_REJECT;
          }
          p = p.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const matches: { node: Text; index: number }[] = [];

    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      const text = node.textContent || '';
      let idx = text.toLowerCase().indexOf(queryLower);
      while (idx !== -1) {
        matches.push({ node, index: idx });
        idx = text.toLowerCase().indexOf(queryLower, idx + queryLower.length);
      }
    }

    for (let i = matches.length - 1; i >= 0; i--) {
      const { node: textNode, index } = matches[i];
      const after = textNode.splitText(index + queryLower.length);
      const matchNode = textNode.splitText(index);
      const mark = document.createElement('mark');
      mark.setAttribute('data-search-hl', '');
      mark.style.backgroundColor = '#FFE500';
      mark.style.color = 'black';
      mark.className = 'rounded-sm px-px font-semibold';
      mark.textContent = matchNode.textContent;
      matchNode.parentNode!.replaceChild(mark, matchNode);
      void after;
    }
  }, []);

  const handleSearchNavigate = useCallback(
    (
      messageId: string,
      query: string,
      withinIdx: number,
      reportMarkCount?: (messageId: string, count: number) => void,
    ) => {
      const needsRehighlight =
        highlightedMsgRef.current !== messageId || highlightedQueryRef.current !== query;
      if (needsRehighlight) {
        clearSearchHighlights();
        highlightedMsgRef.current = messageId;
        highlightedQueryRef.current = query;
      }
      streamRef.current?.expandToItem(messageId);

      const focusOccurrence = () => {
        const el = streamRef.current?.scrollViewport?.querySelector(
          `[data-item-key="${CSS.escape(messageId)}"]`,
        );
        if (!el) return false;

        if (needsRehighlight) highlightTextInElement(el, query);

        const marks = el.querySelectorAll('mark[data-search-hl]');
        reportMarkCount?.(messageId, marks.length);

        if (marks.length === 0) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return true;
        }

        // Move "current" emphasis to the requested occurrence.
        marks.forEach((m) => {
          const mEl = m as HTMLElement;
          mEl.removeAttribute('data-search-current');
          mEl.style.backgroundColor = '#FFE500';
          mEl.style.boxShadow = '';
        });
        const clampedIdx = Math.max(0, Math.min(withinIdx, marks.length - 1));
        const target = marks[clampedIdx] as HTMLElement | undefined;
        if (target) {
          target.setAttribute('data-search-current', '');
          target.style.backgroundColor = '#FF8A00';
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        return true;
      };

      if (!focusOccurrence()) {
        // Element may not have rendered yet (virtualized list, just expanded).
        requestAnimationFrame(() => {
          if (!focusOccurrence()) requestAnimationFrame(focusOccurrence);
        });
      }
    },
    [clearSearchHighlights, highlightTextInElement, streamRef],
  );

  const handleSearchClose = useCallback(() => {
    setSearchOpen(false);
    clearSearchHighlights();
    highlightedMsgRef.current = null;
    highlightedQueryRef.current = '';
  }, [clearSearchHighlights]);

  return { searchOpen, handleSearchNavigate, handleSearchClose };
}

interface Props {
  activeThread: ActiveThread;
}

export function ThreadChatView({ activeThread }: Props) {
  const { t } = useTranslation();
  const stableMessages = useThreadMessages();
  const stableThreadEvents = useThreadEvents();
  const stableCompactionEvents = useCompactionEvents();
  const timelineVisible = useUIStore((s) => s.timelineVisible);
  const loadOlderMessages = useThreadStore((s) => s.loadOlderMessages);
  const hasMore = activeThread.hasMore ?? false;
  const loadingMore = activeThread.loadingMore ?? false;
  const prefersReducedMotion = useReducedMotion();

  const streamRef = useRef<MessageStreamHandle>(null);
  const [visibleMessageId, setVisibleMessageId] = useState<string | null>(null);
  const { openLightbox, lightbox } = useImageLightbox();

  const pendingSendRef = useRef<PendingSend | null>(null);
  const setPromptRef = useRef<((text: string) => void) | null>(null);
  const activeThreadRef = useRef<ActiveThread | null>(activeThread);
  activeThreadRef.current = activeThread;
  const sendingRef = useRef(false);

  const handlers = useThreadHandlers({
    activeThreadRef,
    sendingRef,
    streamRef,
    pendingSendRef,
    setPromptRef,
  });
  const {
    sending,
    followUpDialogOpen,
    handleSend,
    handleFollowUpAction,
    handleFollowUpCancel,
    handleStop,
    handlePermissionApproval,
    handleToolRespond,
    handleFork,
    handleRewind,
    handleForkAndRewind,
    forkingMessageId,
  } = handlers;

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

  const { searchOpen, handleSearchNavigate, handleSearchClose } = useThreadSearch(
    activeThread.id,
    streamRef,
  );

  const uiQueuedCount = activeThread.queuedCount ?? 0;
  const isRunning = activeThread.status === 'running' || uiQueuedCount > 0;
  const isExternal = activeThread.provider === 'external';
  const currentProject = useProjectStore
    .getState()
    .projects.find((p) => p.id === activeThread.projectId);
  const followUpMode = currentProject?.followUpMode || DEFAULT_FOLLOW_UP_MODE;
  const isQueueMode = followUpMode === 'queue' || followUpMode === 'ask';

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col">
      <ProjectHeader />
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
            onSend={handleSend}
            onPermissionApproval={handlePermissionApproval}
            onToolRespond={handleToolRespond}
            onFork={handleFork}
            onRewind={handleRewind}
            onForkAndRewind={handleForkAndRewind}
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
            pagination={{ hasMore, loadingMore, load: loadOlderMessages }}
            createdAt={activeThread.createdAt}
            snapshotMap={snapshotMap}
            knownIds={knownIdsRef.current}
            onOpenLightbox={openLightbox}
            onVisibleMessageChange={setVisibleMessageId}
            prefersReducedMotion={prefersReducedMotion}
            footer={
              activeThread.waitingReason === 'plan' ? null : (
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
      <FollowUpModeDialog
        open={followUpDialogOpen}
        onInterrupt={() => handleFollowUpAction('interrupt')}
        onQueue={() => handleFollowUpAction('queue')}
        onCancel={handleFollowUpCancel}
      />
    </div>
  );
}
