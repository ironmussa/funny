import { ArrowDown } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  forwardRef,
  useImperativeHandle,
} from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { LoadingState } from '@/components/ui/loading-state';
import { loadThreadScrollProgress, saveThreadScrollProgress } from '@/lib/thread-scroll-position';
import { timeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';
import { selectLastMessage, selectFirstMessage } from '@/stores/thread-selectors';

import { InitInfoCard } from './InitInfoCard';
import {
  MemoizedMessageList,
  EMPTY_MESSAGES,
  type MemoizedMessageListHandle,
} from './MemoizedMessageList';
import type { MessageStreamHandle, MessageStreamProps } from './message-stream-types';
import { MessageStreamStatusTail } from './MessageStreamStatusTail';

export type { MessageStreamHandle, MessageStreamProps } from './message-stream-types';

const EMPTY_SNAPSHOT_MAP = new Map<string, number>();
const EMPTY_KNOWN_IDS = new Set<string>();

const DEFAULT_MSG_HEIGHT_PX = 140;
const MIN_MSG_HEIGHT_PX = 24;
const MAX_MSG_HEIGHT_PX = 2000;
const STICKY_BOTTOM_THRESHOLD_PX = 80;

function getDistanceFromBottom(
  viewport: HTMLDivElement,
  metrics: { scrollHeight: number; clientHeight: number } = viewport,
) {
  return Math.max(0, metrics.scrollHeight - viewport.scrollTop - metrics.clientHeight);
}

function getScrollProgress(viewport: HTMLDivElement) {
  const scrollableRange = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  if (scrollableRange <= 0) return 1;
  return Math.min(1, Math.max(0, viewport.scrollTop / scrollableRange));
}

type ThreadScrollPosition = {
  scrollProgress: number;
  atBottom: boolean;
  userHasScrolledUp: boolean;
};

export const MessageStream = forwardRef<MessageStreamHandle, MessageStreamProps>(
  function MessageStream(props, ref) {
    const {
      threadId,
      status,
      messages,
      threadEvents,
      compactionEvents,
      initInfo,
      resultInfo,
      waitingReason,
      pendingPermission,
      isExternal = false,
      onSend,
      onPermissionApproval,
      onToolRespond,
      onFork,
      onRewind,
      onForkAndRewind,
      forkingMessageId,
      rewindDisabled,
      rewindDisabledReason,
      model = '',
      permissionMode = '',
      sessionChanges,
      onSessionReverted,
      pagination,
      createdAt,
      snapshotMap = EMPTY_SNAPSHOT_MAP,
      knownIds = EMPTY_KNOWN_IDS,
      onOpenLightbox,
      onVisibleMessageChange,
      compact = false,
      footer,
      prefersReducedMotion: prefersReducedMotionProp,
      className,
    } = props;

    const { t } = useTranslation();
    const systemReducedMotion = useReducedMotion();
    const prefersReducedMotion = prefersReducedMotionProp ?? systemReducedMotion;

    const isRunning = status === 'running';
    const hasMore = pagination?.hasMore ?? false;
    const hasMoreAfter = pagination?.hasMoreAfter ?? false;
    const loadingMore = pagination?.loadingMore ?? false;
    const totalMessages = pagination?.total ?? 0;
    const loadedCount = messages?.length ?? 0;
    const windowStart =
      pagination?.windowStart ?? (hasMore ? Math.max(0, totalMessages - loadedCount) : 0);
    const unloadedBeforeCount = hasMore ? Math.max(0, windowStart) : 0;
    const unloadedAfterCount = hasMoreAfter
      ? Math.max(0, totalMessages - windowStart - loadedCount)
      : 0;

    const scrollViewportRef = useRef<HTMLDivElement>(null);
    const threadIdRef = useRef(threadId);
    threadIdRef.current = threadId;
    const userHasScrolledUp = useRef(false);
    const smoothScrollPending = useRef(false);
    const scrollingToBottomRef = useRef(false);
    const scrolledThreadRef = useRef<string | null>(null);
    const prevOldestIdRef = useRef<string | null>(null);
    const prevScrollHeightRef = useRef(0);
    const prevStickyMetricsRef = useRef<{ scrollHeight: number; clientHeight: number } | null>(
      null,
    );
    const threadScrollPositionsRef = useRef<Map<string, ThreadScrollPosition> | null>(null);
    if (threadScrollPositionsRef.current === null) {
      threadScrollPositionsRef.current = new Map();
    }
    const scrollDownRef = useRef<HTMLDivElement>(null);
    const contentStackRef = useRef<HTMLDivElement>(null);
    const messageListRef = useRef<MemoizedMessageListHandle>(null);
    const handleViewportScrollRef = useRef<() => void>(() => {});

    const listWrapperRef = useRef<HTMLDivElement>(null);
    const avgMsgHeightRef = useRef(DEFAULT_MSG_HEIGHT_PX);
    const [phantomHeight, setPhantomHeight] = useState(0);
    const [bottomPhantomHeight, setBottomPhantomHeight] = useState(0);
    const phantomHeightRef = useRef(0);
    phantomHeightRef.current = phantomHeight;
    const bottomPhantomHeightRef = useRef(0);
    bottomPhantomHeightRef.current = bottomPhantomHeight;
    const prevPhantomAppliedRef = useRef(0);
    const prevThreadForPhantomRef = useRef(threadId);
    if (prevThreadForPhantomRef.current !== threadId) {
      prevThreadForPhantomRef.current = threadId;
      avgMsgHeightRef.current = DEFAULT_MSG_HEIGHT_PX;
      prevPhantomAppliedRef.current = 0;
      if (phantomHeight !== 0) setPhantomHeight(0);
      if (bottomPhantomHeight !== 0) setBottomPhantomHeight(0);
    }

    const pinnedPromptIdRef = useRef<string | null>(null);
    const [promptPinSpacerHeight, setPromptPinSpacerHeight] = useState(0);
    const promptPinSpacerHeightRef = useRef(0);
    promptPinSpacerHeightRef.current = promptPinSpacerHeight;

    const noopLightbox = useCallback(
      (_images: { src: string; alt: string }[], _index: number) => {},
      [],
    );
    const effectiveOpenLightbox = onOpenLightbox ?? noopLightbox;

    const lastUserMsgIdRef = useRef<string | null>(null);
    useEffect(() => {
      if (!messages?.length) {
        lastUserMsgIdRef.current = null;
        return;
      }
      const last = messages.filter((m: any) => m.role === 'user' && m.content?.trim()).at(-1);
      lastUserMsgIdRef.current = last?.id ?? null;
    }, [messages]);

    const threadData = { messages, status } as any;
    const lastMessage = selectLastMessage(threadData);

    const lastUserMessageId = useMemo(() => {
      if (!messages?.length) return null;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') return messages[i].id;
      }
      return null;
    }, [messages]);
    const prevLastUserMessageIdRef = useRef(lastUserMessageId);
    const lastUserMessageIdForThreadSwitchRef = useRef(lastUserMessageId);
    lastUserMessageIdForThreadSwitchRef.current = lastUserMessageId;
    const prevWaitingReasonRef = useRef(waitingReason);
    const waitingReasonForThreadSwitchRef = useRef(waitingReason);
    waitingReasonForThreadSwitchRef.current = waitingReason;

    const scrollFingerprint = [
      lastMessage?.id,
      lastMessage?.content?.length,
      lastMessage?.toolCalls?.length,
      status,
      waitingReason ?? '',
      !!initInfo,
    ].join(':');

    const updateStickyMetrics = useCallback((viewport: HTMLDivElement) => {
      prevStickyMetricsRef.current = {
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight,
      };
    }, []);

    const updateScrollDownButton = useCallback((viewport: HTMLDivElement, isAtBottom: boolean) => {
      const hasOverflow = viewport.scrollHeight > viewport.clientHeight + 10;
      const shouldShow = hasOverflow && !isAtBottom && !scrollingToBottomRef.current;
      if (scrollDownRef.current) {
        scrollDownRef.current.style.display = shouldShow ? '' : 'none';
      }
    }, []);

    const saveThreadScrollPosition = useCallback((id: string, viewport: HTMLDivElement) => {
      if (threadIdRef.current !== id) return;

      const distanceFromBottom = getDistanceFromBottom(viewport);
      const atBottom = distanceFromBottom <= STICKY_BOTTOM_THRESHOLD_PX;
      threadScrollPositionsRef.current!.set(id, {
        scrollProgress: atBottom ? 1 : getScrollProgress(viewport),
        atBottom,
        userHasScrolledUp: userHasScrolledUp.current,
      });
      saveThreadScrollProgress(id, atBottom ? 1 : getScrollProgress(viewport));
    }, []);

    const applyThreadScrollPosition = useCallback(
      (viewport: HTMLDivElement, id: string) => {
        if (threadIdRef.current !== id) return;

        const storedProgress = loadThreadScrollProgress(id);
        const saved =
          threadScrollPositionsRef.current!.get(id) ??
          (storedProgress !== undefined
            ? {
                scrollProgress: storedProgress,
                atBottom: storedProgress >= 0.999,
                userHasScrolledUp: storedProgress < 0.999,
              }
            : undefined);

        if (!saved || saved.atBottom) {
          scrollingToBottomRef.current = false;
          userHasScrolledUp.current = false;
          viewport.scrollTop = viewport.scrollHeight;
          updateStickyMetrics(viewport);
          saveThreadScrollPosition(id, viewport);
          updateScrollDownButton(viewport, true);
          return;
        }

        scrollingToBottomRef.current = false;
        const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        viewport.scrollTop = saved.scrollProgress * maxScrollTop;
        userHasScrolledUp.current = saved.userHasScrolledUp;
        updateStickyMetrics(viewport);
        updateScrollDownButton(
          viewport,
          getDistanceFromBottom(viewport) <= STICKY_BOTTOM_THRESHOLD_PX,
        );
      },
      [saveThreadScrollPosition, updateScrollDownButton, updateStickyMetrics],
    );

    const wasViewportPinnedBeforeLayoutChange = useCallback((viewport: HTMLDivElement) => {
      const previousMetrics = prevStickyMetricsRef.current ?? viewport;
      return getDistanceFromBottom(viewport, previousMetrics) <= STICKY_BOTTOM_THRESHOLD_PX;
    }, []);

    const pinViewportToBottom = useCallback(
      (viewport: HTMLDivElement) => {
        const targetThreadId = threadId;
        scrollingToBottomRef.current = true;
        viewport.scrollTop = viewport.scrollHeight;
        updateStickyMetrics(viewport);
        saveThreadScrollPosition(targetThreadId, viewport);
        requestAnimationFrame(() => {
          if (threadIdRef.current !== targetThreadId) return;
          viewport.scrollTop = viewport.scrollHeight;
          updateStickyMetrics(viewport);
          saveThreadScrollPosition(targetThreadId, viewport);
          requestAnimationFrame(() => {
            if (threadIdRef.current !== targetThreadId) return;
            if (!userHasScrolledUp.current) {
              viewport.scrollTop = viewport.scrollHeight;
              updateStickyMetrics(viewport);
              saveThreadScrollPosition(targetThreadId, viewport);
            }
            scrollingToBottomRef.current = false;
          });
        });
      },
      [saveThreadScrollPosition, threadId, updateStickyMetrics],
    );

    useLayoutEffect(() => {
      const viewport = scrollViewportRef.current;
      if (!viewport || !threadId) return;

      const saved = threadScrollPositionsRef.current!.get(threadId);
      userHasScrolledUp.current = saved ? saved.userHasScrolledUp : false;
      prevOldestIdRef.current = null;
      prevScrollHeightRef.current = 0;
      prevStickyMetricsRef.current = null;
      pinnedPromptIdRef.current = null;
      scrolledThreadRef.current = threadId;
      prevLastUserMessageIdRef.current = lastUserMessageIdForThreadSwitchRef.current;
      prevWaitingReasonRef.current = waitingReasonForThreadSwitchRef.current;
      setPromptPinSpacerHeight(0);

      let cancelled = false;
      applyThreadScrollPosition(viewport, threadId);
      const firstRafId = requestAnimationFrame(() => {
        if (cancelled) return;
        applyThreadScrollPosition(viewport, threadId);
        requestAnimationFrame(() => {
          if (cancelled) return;
          applyThreadScrollPosition(viewport, threadId);
        });
      });

      return () => {
        cancelled = true;
        cancelAnimationFrame(firstRafId);
      };
    }, [threadId, applyThreadScrollPosition]);

    handleViewportScrollRef.current = () => {
      const viewport = scrollViewportRef.current;
      if (!viewport) return;

      const { scrollTop, scrollHeight, clientHeight } = viewport;
      const promptPinned = !compact && promptPinSpacerHeightRef.current > 0;
      const isAtBottom = getDistanceFromBottom(viewport) <= STICKY_BOTTOM_THRESHOLD_PX;
      prevStickyMetricsRef.current = { scrollHeight, clientHeight };

      if (!scrollingToBottomRef.current) {
        userHasScrolledUp.current = promptPinned || !isAtBottom;
      } else if (isAtBottom) {
        scrollingToBottomRef.current = false;
        userHasScrolledUp.current = false;
      }

      saveThreadScrollPosition(threadId, viewport);
      updateScrollDownButton(viewport, isAtBottom);

      // Load older messages when scrolled near the top of the loaded window.
      // The phantom spacer pushes real content down by its height, so the
      // trigger zone shifts down with it.
      if (
        pagination &&
        scrollTop < phantomHeightRef.current + 200 &&
        hasMore &&
        !loadingMore &&
        !messageListRef.current?.hasHiddenItems()
      ) {
        messageListRef.current?.captureScrollAnchor();
        pagination.load();
      }

      if (
        pagination?.loadAfter &&
        hasMoreAfter &&
        !loadingMore &&
        scrollTop + clientHeight > scrollHeight - bottomPhantomHeightRef.current - 200
      ) {
        pagination.loadAfter();
      }

      if (!compact && isAtBottom && lastUserMsgIdRef.current && onVisibleMessageChange) {
        onVisibleMessageChange(lastUserMsgIdRef.current);
      }
    };

    useEffect(() => {
      const viewport = scrollViewportRef.current;
      if (!viewport) return;

      const handleScroll = () => handleViewportScrollRef.current();
      viewport.addEventListener('scroll', handleScroll, { passive: true });
      return () => viewport.removeEventListener('scroll', handleScroll);
    }, []);

    useEffect(() => {
      if (compact || !onVisibleMessageChange) return;
      const viewport = scrollViewportRef.current;
      if (!viewport || !threadId) return;

      const io = new IntersectionObserver(
        (entries) => {
          if (!userHasScrolledUp.current) return;
          for (const entry of entries) {
            if (entry.isIntersecting) {
              const id = (entry.target as HTMLElement).dataset.userMsg;
              if (id) onVisibleMessageChange(id);
            }
          }
        },
        { root: viewport, rootMargin: '-35% 0px -55% 0px', threshold: [0] },
      );

      const observeAll = () => {
        io.disconnect();
        viewport.querySelectorAll<HTMLElement>('[data-user-msg]').forEach((el) => io.observe(el));
      };
      observeAll();

      let debounceTimer: ReturnType<typeof setTimeout>;
      const mo = new MutationObserver(() => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(observeAll, 200);
      });
      mo.observe(viewport, { childList: true, subtree: true });

      return () => {
        io.disconnect();
        mo.disconnect();
        clearTimeout(debounceTimer);
      };
    }, [threadId, compact, onVisibleMessageChange]);

    useLayoutEffect(() => {
      const isNewThread = threadId != null && scrolledThreadRef.current !== threadId;
      if (isNewThread) {
        scrolledThreadRef.current = threadId;
      }
      smoothScrollPending.current = false;

      const hasNewUserMessage =
        lastUserMessageId != null && lastUserMessageId !== prevLastUserMessageIdRef.current;
      prevLastUserMessageIdRef.current = lastUserMessageId;

      const curWaiting = waitingReason;
      const prevWaiting = prevWaitingReasonRef.current;
      prevWaitingReasonRef.current = curWaiting;
      const needsAttention =
        (curWaiting === 'question' || curWaiting === 'permission') && curWaiting !== prevWaiting;

      if (isNewThread) {
        const viewport = scrollViewportRef.current;
        if (viewport) {
          applyThreadScrollPosition(viewport, threadId);
        }
      } else if (hasNewUserMessage) {
        const viewport = scrollViewportRef.current;
        if (viewport) {
          userHasScrolledUp.current = false;
          pinViewportToBottom(viewport);
        }
      } else if (needsAttention) {
        const viewport = scrollViewportRef.current;
        if (viewport) {
          userHasScrolledUp.current = false;
          requestAnimationFrame(() => {
            viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
          });
        }
      } else if (!userHasScrolledUp.current && !loadingMore) {
        const viewport = scrollViewportRef.current;
        if (viewport && wasViewportPinnedBeforeLayoutChange(viewport)) {
          pinViewportToBottom(viewport);
        } else if (viewport) {
          updateStickyMetrics(viewport);
        }
      }
    }, [
      threadId,
      waitingReason,
      lastUserMessageId,
      loadingMore,
      scrollFingerprint,
      pinViewportToBottom,
      updateStickyMetrics,
      wasViewportPinnedBeforeLayoutChange,
      applyThreadScrollPosition,
    ]);

    const firstMessageId = selectFirstMessage({ messages } as any)?.id ?? null;
    useLayoutEffect(() => {
      if (!pagination) return;
      const oldestId = firstMessageId;
      const viewport = scrollViewportRef.current;

      if (viewport && prevOldestIdRef.current && oldestId && prevOldestIdRef.current !== oldestId) {
        userHasScrolledUp.current = true;
        messageListRef.current?.restoreScrollAnchor();

        const addedHeight = viewport.scrollHeight - prevScrollHeightRef.current;
        if (addedHeight > 0 && !messageListRef.current) {
          viewport.scrollTop += addedHeight;
        }
      }

      prevOldestIdRef.current = oldestId;
      if (viewport) {
        prevScrollHeightRef.current = viewport.scrollHeight;
      }
    }, [firstMessageId, pagination]);

    const recomputePhantom = useCallback(() => {
      const wrapper = listWrapperRef.current;
      if (wrapper && loadedCount > 0) {
        const measured = wrapper.offsetHeight / loadedCount;
        if (measured > 0) {
          avgMsgHeightRef.current = Math.min(
            MAX_MSG_HEIGHT_PX,
            Math.max(MIN_MSG_HEIGHT_PX, measured),
          );
        }
      }
      const nextTop =
        unloadedBeforeCount > 0 ? Math.round(unloadedBeforeCount * avgMsgHeightRef.current) : 0;
      const nextBottom =
        unloadedAfterCount > 0 ? Math.round(unloadedAfterCount * avgMsgHeightRef.current) : 0;
      setPhantomHeight((prev) => (Math.abs(prev - nextTop) > 1 ? nextTop : prev));
      setBottomPhantomHeight((prev) => (Math.abs(prev - nextBottom) > 1 ? nextBottom : prev));
    }, [loadedCount, unloadedAfterCount, unloadedBeforeCount]);

    useLayoutEffect(() => {
      recomputePhantom();
    }, [recomputePhantom]);

    useEffect(() => {
      const wrapper = listWrapperRef.current;
      if (!wrapper) return;
      const ro = new ResizeObserver(() => recomputePhantom());
      ro.observe(wrapper);
      return () => ro.disconnect();
    }, [recomputePhantom]);

    // Keep the viewport visually anchored when the phantom resizes. The phantom
    // sits at the very top, so growing/shrinking it by `delta` shifts everything
    // below by `delta`; matching scrollTop keeps the read position (and the
    // bottom pin) stable instead of lurching. Pagination commits (firstMessageId
    // changed) are owned by restoreScrollAnchor, which measures the true drift
    // including the phantom shrink — so we skip those to avoid double-correcting.
    const prevFirstIdForPhantomRef = useRef(firstMessageId);
    useLayoutEffect(() => {
      const prevPhantom = prevPhantomAppliedRef.current;
      prevPhantomAppliedRef.current = phantomHeight;
      const firstChanged = prevFirstIdForPhantomRef.current !== firstMessageId;
      prevFirstIdForPhantomRef.current = firstMessageId;

      if (firstChanged) return;
      const delta = phantomHeight - prevPhantom;
      if (delta === 0) return;
      const viewport = scrollViewportRef.current;
      if (!viewport) return;

      if (
        !userHasScrolledUp.current &&
        !loadingMore &&
        wasViewportPinnedBeforeLayoutChange(viewport)
      ) {
        pinViewportToBottom(viewport);
      } else {
        viewport.scrollTop += delta;
        updateStickyMetrics(viewport);
      }
    }, [
      phantomHeight,
      firstMessageId,
      loadingMore,
      pinViewportToBottom,
      updateStickyMetrics,
      wasViewportPinnedBeforeLayoutChange,
    ]);

    const scrollToBottom = useCallback(() => {
      const viewport = scrollViewportRef.current;
      if (!viewport) return;
      const targetThreadId = threadId;

      if (!compact && promptPinSpacerHeightRef.current !== 0) {
        pinnedPromptIdRef.current = null;
        flushSync(() => setPromptPinSpacerHeight(0));
      }

      scrollingToBottomRef.current = true;
      userHasScrolledUp.current = false;
      if (scrollDownRef.current) scrollDownRef.current.style.display = 'none';

      viewport.scrollTop = viewport.scrollHeight;
      updateStickyMetrics(viewport);
      saveThreadScrollPosition(targetThreadId, viewport);

      requestAnimationFrame(() => {
        if (threadIdRef.current !== targetThreadId) return;
        requestAnimationFrame(() => {
          if (threadIdRef.current !== targetThreadId) return;
          if (!scrollingToBottomRef.current) return;
          viewport.scrollTop = viewport.scrollHeight;
          updateStickyMetrics(viewport);
          saveThreadScrollPosition(targetThreadId, viewport);
          scrollingToBottomRef.current = false;
        });
      });
    }, [compact, saveThreadScrollPosition, threadId, updateStickyMetrics]);

    useImperativeHandle(
      ref,
      () => ({
        scrollToBottom,
        get scrollViewport() {
          return scrollViewportRef.current;
        },
        expandToItem: (id: string) => messageListRef.current?.expandToItem(id),
        hasHiddenItems: () => messageListRef.current?.hasHiddenItems() ?? false,
        captureScrollAnchor: () => messageListRef.current?.captureScrollAnchor(),
        restoreScrollAnchor: () => messageListRef.current?.restoreScrollAnchor(),
      }),
      [scrollToBottom],
    );

    const handlePermissionApprove = useCallback(() => {
      if (pendingPermission && onPermissionApproval) {
        onPermissionApproval(pendingPermission.toolName, true);
      }
    }, [pendingPermission, onPermissionApproval]);

    const handlePermissionAlwaysAllow = useCallback(() => {
      if (pendingPermission && onPermissionApproval) {
        onPermissionApproval(pendingPermission.toolName, true, true);
      }
    }, [pendingPermission, onPermissionApproval]);

    const handlePermissionDeny = useCallback(() => {
      if (pendingPermission && onPermissionApproval) {
        onPermissionApproval(pendingPermission.toolName, false);
      }
    }, [pendingPermission, onPermissionApproval]);

    return (
      <div
        className={cn(
          'flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto',
          className,
        )}
        ref={scrollViewportRef}
        style={{
          contain: 'layout style',
          scrollbarGutter: compact ? undefined : 'stable',
          overscrollBehaviorY: 'contain',
          overflowAnchor: 'none',
        }}
      >
        {/* Spacer pushes content to bottom */}
        <div className="grow" aria-hidden="true" />

        <div
          ref={contentStackRef}
          className={cn(
            'mx-auto w-full min-w-0 max-w-3xl space-y-4 px-4 py-4',
            compact && 'space-y-2 px-2 py-2',
          )}
        >
          {/* Phantom spacer: reserves scroll height for older messages not yet
              loaded, so the scrollbar reflects the whole conversation and the
              thumb doesn't jump as pages stream in. */}
          {phantomHeight > 0 && (
            <div
              aria-hidden="true"
              data-testid="message-stream-phantom-spacer"
              style={{ height: phantomHeight }}
            />
          )}

          {/* Loading indicator (pagination) */}
          {pagination?.loadingMore && (
            <LoadingState
              fill={false}
              layout="inline"
              size="compact"
              className="py-3"
              testId="message-stream-loading-more"
              label={t('thread.loadingOlder', 'Loading older messages\u2026')}
            />
          )}

          {/* Beginning of conversation marker */}
          {pagination && !hasMore && !loadingMore && messages.length > 0 && (
            <div className="py-2 text-center">
              <span className="text-muted-foreground text-xs">
                {t('thread.beginningOfConversation', 'Beginning of conversation')}
                {createdAt && <> &middot; {timeAgo(createdAt, t)}</>}
              </span>
            </div>
          )}

          {/* Init info card */}
          {initInfo && (
            <InitInfoCard
              initInfo={initInfo}
              effort={messages?.find((m: any) => m.role === 'user')?.effort}
            />
          )}

          {/* Message list — wrapped so we can measure its full height for the
              phantom spacer's per-message estimate. */}
          <div ref={listWrapperRef}>
            <MemoizedMessageList
              key={threadId}
              ref={messageListRef}
              messages={messages ?? EMPTY_MESSAGES}
              threadEvents={threadEvents}
              compactionEvents={compactionEvents}
              threadId={threadId}
              threadStatus={status}
              knownIds={knownIds}
              prefersReducedMotion={prefersReducedMotion}
              snapshotMap={snapshotMap}
              onSend={onSend}
              onOpenLightbox={effectiveOpenLightbox}
              onToolRespond={onToolRespond}
              onFork={onFork}
              onRewind={onRewind}
              onForkAndRewind={onForkAndRewind}
              forkingMessageId={forkingMessageId}
              rewindDisabled={rewindDisabled}
              rewindDisabledReason={rewindDisabledReason}
              scrollRef={scrollViewportRef}
              sessionChanges={sessionChanges}
              changeSummaryRunning={isRunning}
              onSessionReverted={onSessionReverted}
            />
          </div>

          <MessageStreamStatusTail
            status={status}
            waitingReason={waitingReason}
            pendingPermission={pendingPermission}
            isRunning={isRunning}
            isExternal={isExternal}
            compact={compact}
            prefersReducedMotion={prefersReducedMotion}
            resultInfo={resultInfo}
            model={model}
            permissionMode={permissionMode}
            t={t}
            onSend={onSend}
            onPermissionApprove={handlePermissionApprove}
            onPermissionAlwaysAllow={handlePermissionAlwaysAllow}
            onPermissionDeny={handlePermissionDeny}
          />

          {/* Prompt pin spacer (full mode only) */}
          {!compact && promptPinSpacerHeight > 0 && (
            <div aria-hidden="true" style={{ height: promptPinSpacerHeight }} />
          )}

          {bottomPhantomHeight > 0 && (
            <div
              aria-hidden="true"
              data-testid="message-stream-bottom-phantom-spacer"
              style={{ height: bottomPhantomHeight }}
            />
          )}
        </div>

        {/* Sticky bottom dock: scroll-to-bottom button + footer (PromptInput) */}
        <div className="bg-background sticky bottom-0 z-30">
          {/* Scroll to bottom button */}
          <div ref={scrollDownRef} className="relative" style={{ display: 'none' }}>
            <button
              type="button"
              onClick={scrollToBottom}
              data-testid="scroll-to-bottom"
              aria-label={t('thread.scrollToBottom', 'Scroll to bottom')}
              className="border-muted-foreground/40 bg-secondary text-muted-foreground hover:bg-muted absolute bottom-full left-1/2 mb-2 flex -translate-x-1/2 items-center gap-1 rounded-full border px-3 py-1.5 text-xs shadow-md transition-colors"
            >
              <ArrowDown className="icon-xs" />
              {t('thread.scrollToBottom', 'Scroll to bottom')}
            </button>
          </div>
          {footer}
        </div>
      </div>
    );
  },
);
