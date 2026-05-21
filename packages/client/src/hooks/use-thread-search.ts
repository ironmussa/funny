import { useCallback, useRef, useState, type RefObject } from 'react';

import type { MessageStreamHandle } from '@/components/thread/MessageStream';

/**
 * Pure search-state hook for a single thread view. Manages open/close,
 * DOM highlight bookkeeping, and "navigate to occurrence" plumbing.
 *
 * Does NOT wire any keyboard shortcuts — callers attach Ctrl+F (or any
 * other trigger) in a scope that makes sense for them (e.g. window-level
 * for the main chat view, hover/focus-scoped for grid columns).
 */
export function useThreadSearchState(streamRef: RefObject<MessageStreamHandle | null>) {
  const [searchOpen, setSearchOpen] = useState(false);
  const highlightedMsgRef = useRef<string | null>(null);
  const highlightedQueryRef = useRef<string>('');

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

      if (!focusOccurrence()) {
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

  return { searchOpen, setSearchOpen, handleSearchNavigate, handleSearchClose };
}
