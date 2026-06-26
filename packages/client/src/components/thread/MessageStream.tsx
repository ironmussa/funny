import { ArrowDown } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import {
  useState,
  useRef,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useCallback,
  useMemo,
  forwardRef,
  useImperativeHandle,
} from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { LoadingState } from '@/components/ui/loading-state';
import {
  loadThreadScrollPosition as loadStoredThreadScrollPosition,
  saveThreadScrollPosition as saveStoredThreadScrollPosition,
} from '@/lib/thread-scroll-position';
import { timeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';
import { selectLastMessage, selectFirstMessage } from '@/stores/thread-selectors';

import { InitInfoCard } from './InitInfoCard';
import {
  MemoizedMessageList,
  EMPTY_MESSAGES,
  type MemoizedMessageListHandle,
  type MessageListScrollAnchor,
} from './MemoizedMessageList';
import type { MessageStreamHandle, MessageStreamProps } from './message-stream-types';
import { MessageStreamStatusTail } from './MessageStreamStatusTail';

export type { MessageStreamHandle, MessageStreamProps } from './message-stream-types';

const EMPTY_SNAPSHOT_MAP = new Map<string, number>();
const EMPTY_KNOWN_IDS = new Set<string>();

const LOAD_MORE_THRESHOLD_PX = 200;
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

function clampProgress(progress: number) {
  return Math.min(1, Math.max(0, progress));
}

type ThreadScrollPosition = {
  scrollProgress: number;
  atBottom: boolean;
  userHasScrolledUp: boolean;
  anchor: MessageListScrollAnchor | null;
};

export const MessageStream = forwardRef<MessageStreamHandle, MessageStreamProps>(
  function MessageStream(props, ref) {
    const {
      threadId,
      status,
      messages,
      leadingUserMessage,
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
    const hasPagination = pagination != null;
    const hasMore = pagination?.hasMore ?? false;
    const hasMoreAfter = pagination?.hasMoreAfter ?? false;
    const loadingMore = pagination?.loadingMore ?? false;
    const paginationTotal = pagination?.total;
    const paginationWindowStart = pagination?.windowStart;
    const loadedCount = messages?.length ?? 0;
    const scrollViewportRef = useRef<HTMLDivElement>(null);
    const threadIdRef = useRef(threadId);
    threadIdRef.current = threadId;
    const userHasScrolledUp = useRef(false);
    const smoothScrollPending = useRef(false);
    const scrollingToBottomRef = useRef(false);
    const lastScrollTopRef = useRef<number | null>(null);
    const scrolledThreadRef = useRef<string | null>(null);
    const prevOldestIdRef = useRef<string | null>(null);
    const prevNewestIdRef = useRef<string | null>(null);
    const pendingLoadAfterBottomPinRef = useRef(false);
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

    const getThreadScrollProgress = useCallback(
      (viewport: HTMLDivElement) => {
        const localProgress = getScrollProgress(viewport);
        if (
          !hasPagination ||
          typeof paginationTotal !== 'number' ||
          paginationTotal <= 1 ||
          loadedCount <= 0 ||
          typeof paginationWindowStart !== 'number'
        ) {
          return localProgress;
        }

        const loadedSpan = Math.max(0, loadedCount - 1);
        const globalMessageIndex = paginationWindowStart + localProgress * loadedSpan;
        return clampProgress(globalMessageIndex / Math.max(1, paginationTotal - 1));
      },
      [hasPagination, loadedCount, paginationTotal, paginationWindowStart],
    );

    const getLocalScrollProgress = useCallback(
      (threadProgress: number) => {
        if (
          !hasPagination ||
          typeof paginationTotal !== 'number' ||
          paginationTotal <= 1 ||
          loadedCount <= 1 ||
          typeof paginationWindowStart !== 'number'
        ) {
          return clampProgress(threadProgress);
        }

        const targetMessageIndex = clampProgress(threadProgress) * Math.max(1, paginationTotal - 1);
        return clampProgress(
          (targetMessageIndex - paginationWindowStart) / Math.max(1, loadedCount - 1),
        );
      },
      [hasPagination, loadedCount, paginationTotal, paginationWindowStart],
    );

    const saveThreadScrollPosition = useCallback(
      (id: string, viewport: HTMLDivElement) => {
        if (threadIdRef.current !== id) return;

        const distanceFromBottom = getDistanceFromBottom(viewport);
        const atLoadedBottom = distanceFromBottom <= STICKY_BOTTOM_THRESHOLD_PX;
        const atThreadBottom = atLoadedBottom && !hasMoreAfter;
        const scrollProgress = atThreadBottom ? 1 : getThreadScrollProgress(viewport);
        const anchor = atThreadBottom
          ? null
          : (messageListRef.current?.captureVisibleAnchor() ?? null);

        threadScrollPositionsRef.current!.set(id, {
          scrollProgress,
          atBottom: atThreadBottom,
          userHasScrolledUp: userHasScrolledUp.current,
          anchor,
        });
        saveStoredThreadScrollPosition(id, {
          progress: scrollProgress,
          anchor,
        });
      },
      [getThreadScrollProgress, hasMoreAfter],
    );

    const rememberScrollTop = useCallback((viewport: HTMLDivElement) => {
      lastScrollTopRef.current = viewport.scrollTop;
    }, []);

    const applyThreadScrollPosition = useCallback(
      (viewport: HTMLDivElement, id: string) => {
        if (threadIdRef.current !== id) return;

        const storedPosition = loadStoredThreadScrollPosition(id);
        const saved =
          threadScrollPositionsRef.current!.get(id) ??
          (storedPosition
            ? {
                scrollProgress: storedPosition.progress,
                atBottom: storedPosition.progress >= 0.999,
                userHasScrolledUp: storedPosition.progress < 0.999,
                anchor: storedPosition.anchor ?? null,
              }
            : undefined);

        if (!saved || saved.atBottom) {
          scrollingToBottomRef.current = false;
          userHasScrolledUp.current = false;
          viewport.scrollTop = viewport.scrollHeight;
          rememberScrollTop(viewport);
          updateStickyMetrics(viewport);
          saveThreadScrollPosition(id, viewport);
          updateScrollDownButton(viewport, true);
          return;
        }

        scrollingToBottomRef.current = false;
        const restoredAnchor = saved.anchor
          ? (messageListRef.current?.restoreScrollAnchor(saved.anchor) ?? false)
          : false;
        if (restoredAnchor) {
          rememberScrollTop(viewport);
          userHasScrolledUp.current = saved.userHasScrolledUp;
          updateStickyMetrics(viewport);
          updateScrollDownButton(
            viewport,
            getDistanceFromBottom(viewport) <= STICKY_BOTTOM_THRESHOLD_PX,
          );
          requestAnimationFrame(() => {
            if (threadIdRef.current !== id) return;
            rememberScrollTop(viewport);
            updateStickyMetrics(viewport);
            updateScrollDownButton(
              viewport,
              getDistanceFromBottom(viewport) <= STICKY_BOTTOM_THRESHOLD_PX,
            );
          });
          return;
        }

        const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        viewport.scrollTop = getLocalScrollProgress(saved.scrollProgress) * maxScrollTop;
        rememberScrollTop(viewport);
        userHasScrolledUp.current = saved.userHasScrolledUp;
        updateStickyMetrics(viewport);
        updateScrollDownButton(
          viewport,
          getDistanceFromBottom(viewport) <= STICKY_BOTTOM_THRESHOLD_PX,
        );
      },
      [
        getLocalScrollProgress,
        rememberScrollTop,
        saveThreadScrollPosition,
        updateScrollDownButton,
        updateStickyMetrics,
      ],
    );
    const applyThreadScrollPositionEvent = useEffectEvent(applyThreadScrollPosition);

    const wasViewportPinnedBeforeLayoutChange = useCallback((viewport: HTMLDivElement) => {
      const previousMetrics = prevStickyMetricsRef.current ?? viewport;
      return getDistanceFromBottom(viewport, previousMetrics) <= STICKY_BOTTOM_THRESHOLD_PX;
    }, []);

    const pinViewportToBottom = useCallback(
      (viewport: HTMLDivElement) => {
        const targetThreadId = threadId;
        scrollingToBottomRef.current = true;
        viewport.scrollTop = viewport.scrollHeight;
        rememberScrollTop(viewport);
        updateStickyMetrics(viewport);
        saveThreadScrollPosition(targetThreadId, viewport);
        requestAnimationFrame(() => {
          if (threadIdRef.current !== targetThreadId) return;
          if (userHasScrolledUp.current) {
            scrollingToBottomRef.current = false;
            return;
          }
          viewport.scrollTop = viewport.scrollHeight;
          rememberScrollTop(viewport);
          updateStickyMetrics(viewport);
          saveThreadScrollPosition(targetThreadId, viewport);
          requestAnimationFrame(() => {
            if (threadIdRef.current !== targetThreadId) return;
            if (userHasScrolledUp.current) {
              scrollingToBottomRef.current = false;
              return;
            }
            viewport.scrollTop = viewport.scrollHeight;
            rememberScrollTop(viewport);
            updateStickyMetrics(viewport);
            saveThreadScrollPosition(targetThreadId, viewport);
            scrollingToBottomRef.current = false;
          });
        });
      },
      [rememberScrollTop, saveThreadScrollPosition, threadId, updateStickyMetrics],
    );

    useLayoutEffect(() => {
      const viewport = scrollViewportRef.current;
      if (!viewport || !threadId) return;

      const saved = threadScrollPositionsRef.current!.get(threadId);
      userHasScrolledUp.current = saved ? saved.userHasScrolledUp : false;
      prevOldestIdRef.current = null;
      prevNewestIdRef.current = null;
      pendingLoadAfterBottomPinRef.current = false;
      prevScrollHeightRef.current = 0;
      prevStickyMetricsRef.current = null;
      lastScrollTopRef.current = null;
      pinnedPromptIdRef.current = null;
      scrolledThreadRef.current = threadId;
      prevLastUserMessageIdRef.current = lastUserMessageIdForThreadSwitchRef.current;
      prevWaitingReasonRef.current = waitingReasonForThreadSwitchRef.current;
      setPromptPinSpacerHeight(0);

      let cancelled = false;
      applyThreadScrollPositionEvent(viewport, threadId);
      const firstRafId = requestAnimationFrame(() => {
        if (cancelled) return;
        applyThreadScrollPositionEvent(viewport, threadId);
        requestAnimationFrame(() => {
          if (cancelled) return;
          applyThreadScrollPositionEvent(viewport, threadId);
        });
      });

      return () => {
        cancelled = true;
        cancelAnimationFrame(firstRafId);
      };
    }, [threadId]);

    handleViewportScrollRef.current = () => {
      const viewport = scrollViewportRef.current;
      if (!viewport) return;

      const { scrollTop, scrollHeight, clientHeight } = viewport;
      const previousScrollTop = lastScrollTopRef.current ?? scrollTop;
      const isScrollingUp = scrollTop < previousScrollTop - 1;
      lastScrollTopRef.current = scrollTop;
      const promptPinned = !compact && promptPinSpacerHeightRef.current > 0;
      const isAtLoadedBottom = getDistanceFromBottom(viewport) <= STICKY_BOTTOM_THRESHOLD_PX;
      const isAtThreadBottom = isAtLoadedBottom && !hasMoreAfter;
      prevStickyMetricsRef.current = { scrollHeight, clientHeight };

      if (!scrollingToBottomRef.current) {
        userHasScrolledUp.current = promptPinned || !isAtThreadBottom;
      } else if (isScrollingUp && !isAtThreadBottom) {
        scrollingToBottomRef.current = false;
        userHasScrolledUp.current = true;
      } else if (isAtThreadBottom) {
        scrollingToBottomRef.current = false;
        userHasScrolledUp.current = false;
      }

      saveThreadScrollPosition(threadId, viewport);
      updateScrollDownButton(viewport, isAtThreadBottom);

      // Load older messages when scrolled near the top of the loaded window.
      // Unloaded history is not represented by estimated spacers; the scrollbar
      // stays tied to real, currently loaded content.
      if (
        pagination &&
        scrollTop < LOAD_MORE_THRESHOLD_PX &&
        (isScrollingUp || scrollTop <= 1) &&
        hasMore &&
        !loadingMore
      ) {
        messageListRef.current?.captureScrollAnchor();
        pagination.load();
      }

      if (
        pagination?.loadAfter &&
        hasMoreAfter &&
        !loadingMore &&
        scrollTop + clientHeight > scrollHeight - LOAD_MORE_THRESHOLD_PX
      ) {
        pendingLoadAfterBottomPinRef.current = true;
        pagination.loadAfter();
      }

      if (!compact && isAtThreadBottom && lastUserMsgIdRef.current && onVisibleMessageChange) {
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
      if (!hasPagination) return;
      const oldestId = firstMessageId;
      const viewport = scrollViewportRef.current;

      if (viewport && prevOldestIdRef.current && oldestId && prevOldestIdRef.current !== oldestId) {
        userHasScrolledUp.current = true;
        messageListRef.current?.restoreScrollAnchor();

        const addedHeight = viewport.scrollHeight - prevScrollHeightRef.current;
        if (addedHeight > 0 && !messageListRef.current) {
          viewport.scrollTop += addedHeight;
          rememberScrollTop(viewport);
        }
      }

      prevOldestIdRef.current = oldestId;
      if (viewport) {
        prevScrollHeightRef.current = viewport.scrollHeight;
      }
    }, [firstMessageId, hasPagination, rememberScrollTop]);

    const lastMessageId = lastMessage?.id ?? null;
    useLayoutEffect(() => {
      if (!hasPagination) return;
      const viewport = scrollViewportRef.current;
      const previousNewestId = prevNewestIdRef.current;
      const shouldPinAfterAppend = pendingLoadAfterBottomPinRef.current;

      if (
        viewport &&
        shouldPinAfterAppend &&
        previousNewestId &&
        lastMessageId !== previousNewestId
      ) {
        const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        viewport.scrollTop = maxScrollTop;
        rememberScrollTop(viewport);
        updateStickyMetrics(viewport);
        saveThreadScrollPosition(threadId, viewport);
        updateScrollDownButton(viewport, !hasMoreAfter);
        pendingLoadAfterBottomPinRef.current = false;
      } else if (shouldPinAfterAppend && !loadingMore) {
        pendingLoadAfterBottomPinRef.current = false;
      }

      prevNewestIdRef.current = lastMessageId;
    }, [
      hasMoreAfter,
      hasPagination,
      lastMessageId,
      loadingMore,
      rememberScrollTop,
      saveThreadScrollPosition,
      threadId,
      updateScrollDownButton,
      updateStickyMetrics,
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
      rememberScrollTop(viewport);
      updateStickyMetrics(viewport);
      saveThreadScrollPosition(targetThreadId, viewport);

      requestAnimationFrame(() => {
        if (threadIdRef.current !== targetThreadId) return;
        requestAnimationFrame(() => {
          if (threadIdRef.current !== targetThreadId) return;
          if (!scrollingToBottomRef.current) return;
          viewport.scrollTop = viewport.scrollHeight;
          rememberScrollTop(viewport);
          updateStickyMetrics(viewport);
          saveThreadScrollPosition(targetThreadId, viewport);
          scrollingToBottomRef.current = false;
        });
      });
    }, [compact, rememberScrollTop, saveThreadScrollPosition, threadId, updateStickyMetrics]);

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

          {/* Message list wrapper keeps the virtualizer scroll-margin observer stable. */}
          <div>
            <MemoizedMessageList
              key={threadId}
              ref={messageListRef}
              messages={messages ?? EMPTY_MESSAGES}
              leadingUserMessage={leadingUserMessage}
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
