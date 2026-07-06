import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  type RefObject,
} from 'react';

import type { MemoizedMessageListHandle } from './MemoizedMessageList';
import {
  getLastUserMessageId,
  getLastVisibleUserMessageId,
  THREAD_SWITCH_SETTLE_MS,
  type MessageStreamScrollMessage,
} from './message-stream-scroll-utils';
import type { MessageStreamProps } from './message-stream-types';

type ApplyThreadScrollPosition = (viewport: HTMLDivElement, threadId: string) => unknown;
type ViewportCallback = (viewport: HTMLDivElement) => void;

export function useThreadSwitchSettle() {
  const settleRef = useRef<{ threadId: string; until: number } | null>(null);

  const isSettlingThread = useCallback((id: string) => {
    const settle = settleRef.current;
    return settle !== null && settle.threadId === id && Date.now() < settle.until;
  }, []);

  const beginSettle = useCallback((id: string) => {
    settleRef.current = { threadId: id, until: Date.now() + THREAD_SWITCH_SETTLE_MS };
  }, []);

  const clearSettle = useCallback(() => {
    settleRef.current = null;
  }, []);

  return { beginSettle, clearSettle, isSettlingThread };
}

export function useLastUserMessageTracking(messages: readonly MessageStreamScrollMessage[]) {
  const lastVisibleUserMessageIdRef = useRef<string | null>(null);
  useEffect(() => {
    lastVisibleUserMessageIdRef.current = getLastVisibleUserMessageId(messages);
  }, [messages]);

  const lastUserMessageId = useMemo(() => getLastUserMessageId(messages), [messages]);

  return { lastUserMessageId, lastVisibleUserMessageIdRef };
}

export function useThreadSwitchResizeRestore({
  applyThreadScrollPosition,
  contentStackRef,
  isSettlingThread,
  scrollViewportRef,
  threadId,
}: {
  applyThreadScrollPosition: ApplyThreadScrollPosition;
  contentStackRef: RefObject<HTMLDivElement | null>;
  isSettlingThread: (id: string) => boolean;
  scrollViewportRef: RefObject<HTMLDivElement | null>;
  threadId: string;
}) {
  const applyThreadScrollPositionEvent = useEffectEvent(applyThreadScrollPosition);

  // After a thread switch the virtualized list measures its real row heights
  // over several frames. While the switch is settling, keep the saved position
  // converged as late row measurements resize the content.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const viewport = scrollViewportRef.current;
    const content = contentStackRef.current;
    if (!viewport || !content || !threadId) return;

    let stopped = false;
    const reapplyWhileSettling = () => {
      if (stopped || !isSettlingThread(threadId)) return;
      applyThreadScrollPositionEvent(viewport, threadId);
    };

    const ro = new ResizeObserver(reapplyWhileSettling);
    ro.observe(content);
    const stopTimer = setTimeout(() => {
      stopped = true;
      ro.disconnect();
    }, THREAD_SWITCH_SETTLE_MS);

    return () => {
      stopped = true;
      clearTimeout(stopTimer);
      ro.disconnect();
    };
  }, [contentStackRef, isSettlingThread, scrollViewportRef, threadId]);
}

export function useViewportScrollListeners({
  onScrollRef,
  onUserInput,
  scrollViewportRef,
}: {
  onScrollRef: RefObject<() => void>;
  onUserInput: () => void;
  scrollViewportRef: RefObject<HTMLDivElement | null>;
}) {
  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;

    const handleScroll = () => onScrollRef.current();
    viewport.addEventListener('scroll', handleScroll, { passive: true });
    viewport.addEventListener('wheel', onUserInput, { passive: true });
    viewport.addEventListener('touchstart', onUserInput, { passive: true });
    viewport.addEventListener('pointerdown', onUserInput, { passive: true });
    window.addEventListener('keydown', onUserInput);
    return () => {
      viewport.removeEventListener('scroll', handleScroll);
      viewport.removeEventListener('wheel', onUserInput);
      viewport.removeEventListener('touchstart', onUserInput);
      viewport.removeEventListener('pointerdown', onUserInput);
      window.removeEventListener('keydown', onUserInput);
    };
  }, [onScrollRef, onUserInput, scrollViewportRef]);
}

export function useVisibleMessageObserver({
  compact,
  onVisibleMessageChange,
  scrollViewportRef,
  threadId,
  userHasScrolledUpRef,
}: {
  compact: boolean;
  onVisibleMessageChange?: (id: string) => void;
  scrollViewportRef: RefObject<HTMLDivElement | null>;
  threadId: string;
  userHasScrolledUpRef: RefObject<boolean>;
}) {
  const onVisibleMessageChangeEvent = useEffectEvent((id: string) => {
    onVisibleMessageChange?.(id);
  });

  useEffect(() => {
    if (compact || !onVisibleMessageChange) return;
    const viewport = scrollViewportRef.current;
    if (!viewport || !threadId) return;

    const io = new IntersectionObserver(
      (entries) => {
        if (!userHasScrolledUpRef.current) return;
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const id = (entry.target as HTMLElement).dataset.userMsg;
            if (id) onVisibleMessageChangeEvent(id);
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
  }, [compact, onVisibleMessageChange, scrollViewportRef, threadId, userHasScrolledUpRef]);
}

export function useThreadLayoutScrollEffect({
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
  smoothScrollPendingRef,
  threadId,
  updateStickyMetrics,
  userHasScrolledUpRef,
  waitingReason,
  wasViewportPinnedBeforeLayoutChange,
}: {
  applyThreadScrollPosition: ApplyThreadScrollPosition;
  beginSettle: (id: string) => void;
  lastUserMessageId: string | null;
  loadingMore: boolean;
  pinViewportToBottom: ViewportCallback;
  prevLastUserMessageIdRef: RefObject<string | null>;
  prevWaitingReasonRef: RefObject<MessageStreamProps['waitingReason']>;
  scrolledThreadRef: RefObject<string | null>;
  scrollFingerprint: string;
  scrollViewportRef: RefObject<HTMLDivElement | null>;
  smoothScrollPendingRef: RefObject<boolean>;
  threadId: string;
  updateStickyMetrics: ViewportCallback;
  userHasScrolledUpRef: RefObject<boolean>;
  waitingReason: MessageStreamProps['waitingReason'];
  wasViewportPinnedBeforeLayoutChange: (viewport: HTMLDivElement) => boolean;
}) {
  useLayoutEffect(() => {
    const isNewThread = threadId != null && scrolledThreadRef.current !== threadId;
    if (isNewThread) {
      scrolledThreadRef.current = threadId;
    }
    smoothScrollPendingRef.current = false;

    const prevLastUserMessageId = prevLastUserMessageIdRef.current;
    const hasNewUserMessage =
      lastUserMessageId != null && lastUserMessageId !== prevLastUserMessageId;
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
        if (prevLastUserMessageId === null) {
          // The message window filled in after the switch; restore instead of
          // treating the async load as a user send.
          beginSettle(threadId);
          applyThreadScrollPosition(viewport, threadId);
        } else {
          userHasScrolledUpRef.current = false;
          pinViewportToBottom(viewport);
        }
      }
    } else if (needsAttention) {
      const viewport = scrollViewportRef.current;
      if (viewport) {
        userHasScrolledUpRef.current = false;
        requestAnimationFrame(() => {
          viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
        });
      }
    } else if (!userHasScrolledUpRef.current && !loadingMore) {
      const viewport = scrollViewportRef.current;
      if (viewport && wasViewportPinnedBeforeLayoutChange(viewport)) {
        pinViewportToBottom(viewport);
      } else if (viewport) {
        updateStickyMetrics(viewport);
      }
    }
  }, [
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
    smoothScrollPendingRef,
    threadId,
    updateStickyMetrics,
    userHasScrolledUpRef,
    waitingReason,
    wasViewportPinnedBeforeLayoutChange,
  ]);
}

export function usePaginationScrollEffects({
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
  userHasScrolledUpRef,
}: {
  firstMessageId: string | null;
  hasMoreAfter: boolean;
  hasPagination: boolean;
  lastMessageId: string | null;
  loadingMore: boolean;
  messageListRef: RefObject<MemoizedMessageListHandle | null>;
  pendingLoadAfterBottomPinRef: RefObject<boolean>;
  prevNewestIdRef: RefObject<string | null>;
  prevOldestIdRef: RefObject<string | null>;
  prevScrollHeightRef: RefObject<number>;
  rememberScrollTop: ViewportCallback;
  saveThreadScrollPosition: (threadId: string, viewport: HTMLDivElement) => void;
  scrollViewportRef: RefObject<HTMLDivElement | null>;
  threadId: string;
  updateScrollDownButton: (viewport: HTMLDivElement, isAtBottom: boolean) => void;
  updateStickyMetrics: ViewportCallback;
  userHasScrolledUpRef: RefObject<boolean>;
}) {
  useLayoutEffect(() => {
    if (!hasPagination) return;
    const oldestId = firstMessageId;
    const viewport = scrollViewportRef.current;

    if (viewport && prevOldestIdRef.current && oldestId && prevOldestIdRef.current !== oldestId) {
      userHasScrolledUpRef.current = true;
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
  }, [
    firstMessageId,
    hasPagination,
    messageListRef,
    prevOldestIdRef,
    prevScrollHeightRef,
    rememberScrollTop,
    scrollViewportRef,
    userHasScrolledUpRef,
  ]);

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
    pendingLoadAfterBottomPinRef,
    prevNewestIdRef,
    rememberScrollTop,
    saveThreadScrollPosition,
    scrollViewportRef,
    threadId,
    updateScrollDownButton,
    updateStickyMetrics,
  ]);
}
