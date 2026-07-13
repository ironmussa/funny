import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

import { metric } from '@/lib/telemetry';
import { loadThreadScrollPosition, saveThreadScrollPosition } from '@/lib/thread-scroll-position';

import { type MemoizedMessageListHandle } from './MemoizedMessageList';
import {
  getDistanceFromBottom,
  getLastMessage,
  LOAD_MORE_THRESHOLD_PX,
  STICKY_BOTTOM_THRESHOLD_PX,
  type MessageStreamScrollMessage,
} from './message-stream-scroll-utils';
import type { MessageStreamProps } from './message-stream-types';

type UseFrozenScrollOptions = Pick<
  MessageStreamProps,
  'threadId' | 'status' | 'messages' | 'waitingReason' | 'pagination' | 'compact' | 'initInfo'
>;

/**
 * Scroll orchestration for the frozen viewer. Deliberately simpler than
 * `useMessageStreamScroll`: rows live in normal document flow, so native
 * `overflow-anchor` (set by the shell) keeps the scroll position stable during
 * prepends and streaming growth — there is no manual anchor compensation and no
 * post-switch settle window. This hook only adds what the browser cannot do on
 * its own:
 *
 * - bidirectional infinite scroll via IntersectionObserver sentinels wired to
 *   the existing `hasMore` / `hasMoreAfter` windowed pagination (§6.3),
 * - per-thread position persistence via the list's visible-anchor handle (§6.4),
 * - sticky-bottom that follows streaming output unless the user scrolled up
 *   (§6.5) — the one thing native anchoring does NOT do, since it anchors to a
 *   visible row rather than the bottom edge.
 */
export function useFrozenScroll({
  threadId,
  status,
  messages,
  pagination,
}: UseFrozenScrollOptions) {
  const scrollMessages: MessageStreamScrollMessage[] = messages ?? [];

  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const contentStackRef = useRef<HTMLDivElement>(null);
  const scrollDownRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<MemoizedMessageListHandle>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);

  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  const userHasScrolledUpRef = useRef(false);
  const saveRafRef = useRef<number | null>(null);

  // Latest pagination state, read from inside stable observers/listeners so
  // they never close over stale flags.
  const paginationRef = useRef(pagination);
  paginationRef.current = pagination;

  const updateScrollDownButton = useCallback((viewport: HTMLDivElement) => {
    const hasOverflow = viewport.scrollHeight > viewport.clientHeight + 10;
    const atBottom = getDistanceFromBottom(viewport) <= STICKY_BOTTOM_THRESHOLD_PX;
    if (scrollDownRef.current) {
      scrollDownRef.current.style.display = hasOverflow && !atBottom ? '' : 'none';
    }
  }, []);

  const saveScrollPosition = useCallback((id: string) => {
    const viewport = scrollViewportRef.current;
    if (!viewport || threadIdRef.current !== id) return;
    const scrollable = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const progress =
      scrollable <= 0 ? 1 : Math.min(1, Math.max(0, viewport.scrollTop / scrollable));
    const hasMoreAfter = paginationRef.current?.hasMoreAfter ?? false;
    const atBottom = getDistanceFromBottom(viewport) <= STICKY_BOTTOM_THRESHOLD_PX && !hasMoreAfter;
    const anchor = atBottom ? null : (messageListRef.current?.captureVisibleAnchor() ?? null);
    saveThreadScrollPosition(id, { progress: atBottom ? 1 : progress, anchor });
  }, []);

  const scrollToBottom = useCallback(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    userHasScrolledUpRef.current = false;
    viewport.scrollTop = viewport.scrollHeight;
    if (scrollDownRef.current) scrollDownRef.current.style.display = 'none';
    saveScrollPosition(threadIdRef.current);
  }, [saveScrollPosition]);

  // ── Restore position on thread switch (§6.4) ────────────────────────────
  useLayoutEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport || !threadId) return;

    const saved = loadThreadScrollPosition(threadId);
    const restore = (): 'bottom' | 'anchor' | 'progress' => {
      if (!saved || saved.progress >= 0.999) {
        userHasScrolledUpRef.current = false;
        viewport.scrollTop = viewport.scrollHeight;
        return 'bottom';
      }
      userHasScrolledUpRef.current = true;
      if (saved.anchor && messageListRef.current?.restoreScrollAnchor(saved.anchor)) {
        return 'anchor';
      }
      const scrollable = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      viewport.scrollTop = saved.progress * scrollable;
      return 'progress';
    };

    const outcome = restore();
    metric('thread.scroll_restore', 1, { attributes: { outcome } });
    // content-visibility rows settle their real heights over a couple frames;
    // re-apply so an anchor/progress restore lands precisely.
    const raf1 = requestAnimationFrame(() => {
      if (threadIdRef.current !== threadId) return;
      restore();
      updateScrollDownButton(viewport);
    });
    return () => cancelAnimationFrame(raf1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  // Save on unmount so a thread switch persists the last position.
  useEffect(() => {
    return () => {
      if (saveRafRef.current !== null) cancelAnimationFrame(saveRafRef.current);
      saveScrollPosition(threadIdRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Native scroll listener: track pin state, persist, toggle button ─────
  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    const onScroll = () => {
      const atBottom = getDistanceFromBottom(viewport) <= STICKY_BOTTOM_THRESHOLD_PX;
      userHasScrolledUpRef.current = !atBottom;
      updateScrollDownButton(viewport);
      if (saveRafRef.current !== null) return;
      saveRafRef.current = requestAnimationFrame(() => {
        saveRafRef.current = null;
        saveScrollPosition(threadIdRef.current);
      });
    };
    viewport.addEventListener('scroll', onScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', onScroll);
  }, [saveScrollPosition, updateScrollDownButton]);

  // ── Sticky-bottom: follow streaming output unless the user scrolled up ──
  const lastMessage = getLastMessage(scrollMessages);
  const fingerprint = [
    lastMessage?.id,
    lastMessage?.content?.length,
    lastMessage?.toolCalls?.length,
    status,
    scrollMessages.length,
  ].join(':');
  useLayoutEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport || userHasScrolledUpRef.current) return;
    viewport.scrollTop = viewport.scrollHeight;
    updateScrollDownButton(viewport);
  }, [fingerprint, updateScrollDownButton]);

  // ── Bidirectional infinite scroll via IntersectionObserver (§6.3) ───────
  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    const top = topSentinelRef.current;
    const bottom = bottomSentinelRef.current;
    if (!top && !bottom) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const p = paginationRef.current;
        if (!p || p.loadingMore) return;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          if (entry.target === top && p.hasMore) {
            // Native overflow-anchor holds the position when older rows are
            // prepended; still capture an anchor as a belt-and-suspenders hint.
            messageListRef.current?.captureScrollAnchor();
            p.load();
          } else if (entry.target === bottom && p.hasMoreAfter && p.loadAfter) {
            p.loadAfter();
          }
        }
      },
      { root: viewport, rootMargin: `${LOAD_MORE_THRESHOLD_PX}px 0px` },
    );
    if (top) observer.observe(top);
    if (bottom) observer.observe(bottom);
    return () => observer.disconnect();
  }, [threadId, pagination?.hasMore, pagination?.hasMoreAfter, pagination?.loadingMore]);

  return {
    scrollViewportRef,
    contentStackRef,
    scrollDownRef,
    messageListRef,
    topSentinelRef,
    bottomSentinelRef,
    promptPinSpacerHeight: 0,
    scrollToBottom,
  };
}
