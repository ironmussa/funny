import { useCallback, useRef, useState, type RefObject } from 'react';

import type { MessageStreamHandle } from '@/components/thread/MessageStream';
import { useThreadStore } from '@/stores/thread-store';

/**
 * Pure search-state hook for a single thread view. Manages open/close,
 * DOM highlight bookkeeping, and "navigate to occurrence" plumbing.
 *
 * Does NOT wire any keyboard shortcuts — callers attach Ctrl+F (or any
 * other trigger) in a scope that makes sense for them (e.g. window-level
 * for the main chat view, hover/focus-scoped for grid columns).
 */
export function useThreadSearchState(
  streamRef: RefObject<MessageStreamHandle | null>,
  threadId?: string,
) {
  const [searchOpen, setSearchOpen] = useState(false);
  const highlightedMsgRef = useRef<string | null>(null);
  const highlightedQueryRef = useRef<string>('');
  // Monotonic token so a slow page-load for occurrence N is abandoned when
  // the user has already navigated to occurrence N+1.
  const navTokenRef = useRef(0);
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;

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
      mark.style.cssText = 'background-color:#FFE500;color:black';
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
    ): Promise<void> | void => {
      const navToken = ++navTokenRef.current;
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

        marks.forEach((m) => {
          const mEl = m as HTMLElement;
          mEl.removeAttribute('data-search-current');
          Object.assign(mEl.style, { backgroundColor: '#FFE500', boxShadow: '' });
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

      // Retry over a few frames — React may still be committing the
      // prepended pages / expanded window, so re-run expandToItem each
      // attempt (it reads a fresh item index every render and is a no-op
      // once the window already covers the item).
      const retryFocus = (frames: number): Promise<boolean> =>
        new Promise((resolve) => {
          const attempt = (left: number) => {
            if (navTokenRef.current !== navToken) return resolve(false);
            streamRef.current?.expandToItem(messageId);
            if (focusOccurrence()) return resolve(true);
            if (left <= 0) return resolve(false);
            requestAnimationFrame(() => attempt(left - 1));
          };
          attempt(frames);
        });

      // The initial scrollIntoView can be stolen while the thread is still
      // settling: the new-thread sticky-bottom autoscroll, late tool cards /
      // images changing heights, and the windowed list swapping estimated
      // heights for real ones all move the match after we centered it.
      // Re-check for ~2s and re-center on drift; a manual user scroll
      // (wheel/touch) cancels the corrections.
      const keepTargetCentered = () => {
        const viewport = streamRef.current?.scrollViewport;
        if (!viewport) return;
        let cancelled = false;
        const cancel = () => {
          cancelled = true;
        };
        viewport.addEventListener('wheel', cancel, { passive: true });
        viewport.addEventListener('touchstart', cancel, { passive: true });
        const removeListeners = () => {
          viewport.removeEventListener('wheel', cancel);
          viewport.removeEventListener('touchstart', cancel);
        };
        const delays = [600, 1300, 2200];
        delays.forEach((delay, i) => {
          setTimeout(() => {
            const isLast = i === delays.length - 1;
            if (cancelled || navTokenRef.current !== navToken) {
              if (isLast) removeListeners();
              return;
            }
            const el =
              viewport.querySelector('mark[data-search-current]') ??
              viewport.querySelector(`[data-item-key="${CSS.escape(messageId)}"]`);
            if (el instanceof HTMLElement) {
              const vp = viewport.getBoundingClientRect();
              const r = el.getBoundingClientRect();
              const drift = Math.abs(r.top + r.height / 2 - (vp.top + vp.height / 2));
              if (drift > vp.height * 0.3) {
                el.scrollIntoView({ behavior: 'auto', block: 'center' });
              }
            }
            if (isLast) removeListeners();
          }, delay);
        });
      };

      if (focusOccurrence()) {
        keepTargetCentered();
        return;
      }

      return (async () => {
        if (await retryFocus(2)) {
          keepTargetCentered();
          return;
        }

        // The message is in a page that hasn't been loaded yet (search runs
        // server-side over the full history, the view paginates). Load older
        // pages until it lands in the store, then expand + focus again.
        const tid = threadIdRef.current;
        if (!tid) return;
        const store = useThreadStore.getState();
        const alreadyLoaded =
          store.threadDataById[tid]?.messages.some((m) => m.id === messageId) ?? false;
        if (!alreadyLoaded) {
          const found = await store.loadMessagesUntil(tid, messageId);
          if (!found || navTokenRef.current !== navToken) return;
        }
        if (await retryFocus(10)) keepTargetCentered();
      })();
    },
    [clearSearchHighlights, highlightTextInElement, streamRef],
  );

  const handleSearchClose = useCallback(() => {
    setSearchOpen(false);
    clearSearchHighlights();
    highlightedMsgRef.current = null;
    highlightedQueryRef.current = '';
  }, [clearSearchHighlights]);

  return { searchOpen, setSearchOpen, handleSearchNavigate, handleSearchClose };
}
