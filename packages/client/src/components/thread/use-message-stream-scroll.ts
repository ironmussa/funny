import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';

import { metric } from '@/lib/telemetry';
import {
  loadThreadScrollPosition as loadStoredThreadScrollPosition,
  saveThreadScrollPosition as saveStoredThreadScrollPosition,
} from '@/lib/thread-scroll-position';

import { type MemoizedMessageListHandle } from './MemoizedMessageList';
import {
  getDistanceFromBottom,
  getFirstMessageId,
  getLastMessage,
  getLocalScrollProgress,
  getThreadScrollProgress,
  LOAD_MORE_THRESHOLD_PX,
  STICKY_BOTTOM_THRESHOLD_PX,
  type MessageStreamScrollMessage,
  type ScrollRestoreOutcome,
  type ThreadScrollPosition,
} from './message-stream-scroll-utils';
import type { MessageStreamProps } from './message-stream-types';
import {
  useLastUserMessageTracking,
  usePaginationScrollEffects,
  useThreadLayoutScrollEffect,
  useThreadSwitchResizeRestore,
  useThreadSwitchSettle,
  useViewportScrollListeners,
  useVisibleMessageObserver,
} from './use-message-stream-scroll-effects';

type UseMessageStreamScrollOptions = Pick<
  MessageStreamProps,
  | 'threadId'
  | 'status'
  | 'messages'
  | 'waitingReason'
  | 'pagination'
  | 'compact'
  | 'initInfo'
  | 'onVisibleMessageChange'
>;

// eslint-disable-next-line max-lines-per-function -- Scroll restoration/pinning state is isolated here; split effects after the behavior is fully covered.
export function useMessageStreamScroll({
  threadId,
  status,
  messages,
  waitingReason,
  pagination,
  compact = false,
  initInfo,
  onVisibleMessageChange,
}: UseMessageStreamScrollOptions) {
  const scrollMessages: MessageStreamScrollMessage[] = messages ?? [];
  const hasPagination = pagination != null;
  const hasMore = pagination?.hasMore ?? false;
  const hasMoreAfter = pagination?.hasMoreAfter ?? false;
  const loadingMore = pagination?.loadingMore ?? false;
  const paginationTotal = pagination?.total;
  const paginationWindowStart = pagination?.windowStart;
  const loadedCount = scrollMessages.length;
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  // threadIdRef is assigned during render, which under startTransition runs
  // BEFORE the DOM commits. committedThreadIdRef only advances in an effect,
  // so it always matches the thread whose content is actually in the DOM.
  const committedThreadIdRef = useRef<string | null>(null);
  const { beginSettle, clearSettle, isSettlingThread } = useThreadSwitchSettle();
  const userHasScrolledUp = useRef(false);
  const smoothScrollPending = useRef(false);
  const scrollingToBottomRef = useRef(false);
  const lastScrollTopRef = useRef<number | null>(null);
  const scrolledThreadRef = useRef<string | null>(null);
  const prevOldestIdRef = useRef<string | null>(null);
  const prevNewestIdRef = useRef<string | null>(null);
  const pendingLoadAfterBottomPinRef = useRef(false);
  const prevScrollHeightRef = useRef(0);
  const prevStickyMetricsRef = useRef<{ scrollHeight: number; clientHeight: number } | null>(null);
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

  const { lastUserMessageId, lastVisibleUserMessageIdRef } =
    useLastUserMessageTracking(scrollMessages);
  const lastMessage = getLastMessage(scrollMessages);
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

  const getCurrentThreadScrollProgress = useCallback(
    (viewport: HTMLDivElement) => {
      return getThreadScrollProgress(viewport, {
        hasPagination,
        loadedCount,
        paginationTotal,
        paginationWindowStart,
      });
    },
    [hasPagination, loadedCount, paginationTotal, paginationWindowStart],
  );

  const getCurrentLocalScrollProgress = useCallback(
    (threadProgress: number) => {
      return getLocalScrollProgress(threadProgress, {
        hasPagination,
        loadedCount,
        paginationTotal,
        paginationWindowStart,
      });
    },
    [hasPagination, loadedCount, paginationTotal, paginationWindowStart],
  );

  const saveThreadScrollPosition = useCallback(
    (id: string, viewport: HTMLDivElement) => {
      if (threadIdRef.current !== id) return;

      const distanceFromBottom = getDistanceFromBottom(viewport);
      const atLoadedBottom = distanceFromBottom <= STICKY_BOTTOM_THRESHOLD_PX;
      const atThreadBottom = atLoadedBottom && !hasMoreAfter;
      const scrollProgress = atThreadBottom ? 1 : getCurrentThreadScrollProgress(viewport);
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
    [getCurrentThreadScrollProgress, hasMoreAfter],
  );

  const rememberScrollTop = useCallback((viewport: HTMLDivElement) => {
    lastScrollTopRef.current = viewport.scrollTop;
  }, []);

  const applyThreadScrollPosition = useCallback(
    (viewport: HTMLDivElement, id: string): ScrollRestoreOutcome => {
      if (threadIdRef.current !== id) return 'skipped';

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
        return 'bottom';
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
        return 'anchor';
      }

      const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      viewport.scrollTop = getCurrentLocalScrollProgress(saved.scrollProgress) * maxScrollTop;
      rememberScrollTop(viewport);
      userHasScrolledUp.current = saved.userHasScrolledUp;
      updateStickyMetrics(viewport);
      updateScrollDownButton(
        viewport,
        getDistanceFromBottom(viewport) <= STICKY_BOTTOM_THRESHOLD_PX,
      );
      return 'progress';
    },
    [
      getCurrentLocalScrollProgress,
      rememberScrollTop,
      saveThreadScrollPosition,
      updateScrollDownButton,
      updateStickyMetrics,
    ],
  );
  const applyThreadScrollPositionEvent = useEffectEvent(applyThreadScrollPosition);
  const saveUnmountScrollPositionEvent = useEffectEvent(() => {
    const viewport = scrollViewportRef.current;
    const committedThreadId = committedThreadIdRef.current;
    if (!viewport || !committedThreadId) return;
    saveThreadScrollPosition(committedThreadId, viewport);
  });

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

    committedThreadIdRef.current = threadId;
    beginSettle(threadId);
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
    const outcome = applyThreadScrollPositionEvent(viewport, threadId);
    metric('thread.scroll_restore', 1, { attributes: { outcome } });
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
  }, [beginSettle, threadId]);

  useEffect(() => {
    return () => {
      saveUnmountScrollPositionEvent();
    };
  }, []);

  useThreadSwitchResizeRestore({
    applyThreadScrollPosition,
    contentStackRef,
    isSettlingThread,
    scrollViewportRef,
    threadId,
  });

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

    // Scroll events that fire while a thread switch is still rendering
    // (committed id behind the rendered id under startTransition) or
    // settling (restore writes, browser clamps, virtualizer re-measures)
    // carry no user intent. Treating them as user scrolls used to flip
    // userHasScrolledUp (cancelling the bottom re-pin) and overwrite the
    // saved position with half-measured geometry: persisted corruption.
    // Real input (wheel/touch/pointer/key) ends the settle window first.
    if (threadId !== committedThreadIdRef.current || isSettlingThread(threadId)) {
      updateScrollDownButton(viewport, isAtThreadBottom);
      return;
    }

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

    if (
      !compact &&
      isAtThreadBottom &&
      lastVisibleUserMessageIdRef.current &&
      onVisibleMessageChange
    ) {
      onVisibleMessageChange(lastVisibleUserMessageIdRef.current);
    }
  };

  useViewportScrollListeners({
    onScrollRef: handleViewportScrollRef,
    onUserInput: clearSettle,
    scrollViewportRef,
  });

  useVisibleMessageObserver({
    compact,
    onVisibleMessageChange,
    scrollViewportRef,
    threadId,
    userHasScrolledUpRef: userHasScrolledUp,
  });

  useThreadLayoutScrollEffect({
    applyThreadScrollPosition,
    beginSettle,
    lastUserMessageId,
    loadingMore,
    pinViewportToBottom,
    prevLastUserMessageIdRef,
    prevWaitingReasonRef,
    scrolledThreadRef,
    scrollFingerprint,
    scrollViewportRef,
    smoothScrollPendingRef: smoothScrollPending,
    threadId,
    updateStickyMetrics,
    userHasScrolledUpRef: userHasScrolledUp,
    waitingReason,
    wasViewportPinnedBeforeLayoutChange,
  });

  const firstMessageId = getFirstMessageId(scrollMessages);
  const lastMessageId = lastMessage?.id ?? null;

  usePaginationScrollEffects({
    firstMessageId,
    hasMoreAfter,
    hasPagination,
    lastMessageId,
    loadingMore,
    messageListRef,
    pendingLoadAfterBottomPinRef,
    prevNewestIdRef,
    prevOldestIdRef,
    prevScrollHeightRef,
    rememberScrollTop,
    saveThreadScrollPosition,
    scrollViewportRef,
    threadId,
    updateScrollDownButton,
    updateStickyMetrics,
    userHasScrolledUpRef: userHasScrolledUp,
  });

  const scrollToBottom = useCallback(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    const targetThreadId = threadId;

    if (!compact && promptPinSpacerHeightRef.current !== 0) {
      pinnedPromptIdRef.current = null;
      setPromptPinSpacerHeight(0);
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

  return {
    contentStackRef,
    messageListRef,
    promptPinSpacerHeight,
    scrollDownRef,
    scrollToBottom,
    scrollViewportRef,
  };
}
