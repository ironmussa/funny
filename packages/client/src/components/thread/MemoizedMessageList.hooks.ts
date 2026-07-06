import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';

import { ensurePretextLoaded, getCachedPrepared, prepareBatch } from '@/hooks/use-pretext';
import { analyzeMarkdown } from '@/lib/markdown-to-plaintext';
import { parseReferencedFiles } from '@/lib/parse-referenced-files';
import type { RenderItem } from '@/lib/render-items';

import type { FontConfig } from './MemoizedMessageList.measurement';

export function useListScrollMargin(
  scrollRef: RefObject<HTMLElement | null>,
  itemContainerRef: RefObject<HTMLElement | null>,
) {
  const [listScrollMargin, setListScrollMargin] = useState(0);

  const measureListScrollMargin = useCallback(() => {
    const viewport = scrollRef.current;
    const container = itemContainerRef.current;
    if (!viewport || !container) return 0;

    const viewportRect = viewport.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    return Math.max(0, Math.round(containerRect.top - viewportRect.top + viewport.scrollTop));
  }, [itemContainerRef, scrollRef]);

  const updateListScrollMargin = useCallback(() => {
    const next = measureListScrollMargin();
    setListScrollMargin((prev) => (Math.abs(prev - next) > 1 ? next : prev));
  }, [measureListScrollMargin]);
  const updateListScrollMarginEvent = useEffectEvent(updateListScrollMargin);

  useLayoutEffect(() => {
    updateListScrollMargin();
  }, [updateListScrollMargin]);

  useEffect(() => {
    const viewport = scrollRef.current;
    const container = itemContainerRef.current;
    const contentStack = container?.parentElement?.parentElement;
    if (!viewport || !container) return;

    let rafId: number | null = null;
    const scheduleUpdate = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        updateListScrollMarginEvent();
      });
    };

    const ro = new ResizeObserver(scheduleUpdate);
    ro.observe(viewport);
    ro.observe(container);
    if (container.parentElement) ro.observe(container.parentElement);
    if (contentStack) ro.observe(contentStack);

    const mo = new MutationObserver(scheduleUpdate);
    if (contentStack) {
      mo.observe(contentStack, {
        attributes: true,
        childList: true,
        subtree: true,
      });
    }

    viewport.addEventListener('scroll', scheduleUpdate, { passive: true });
    scheduleUpdate();

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      ro.disconnect();
      mo.disconnect();
      viewport.removeEventListener('scroll', scheduleUpdate);
    };
  }, [itemContainerRef, scrollRef]);

  return listScrollMargin;
}

export function useContainerWidth(itemContainerRef: RefObject<HTMLElement | null>) {
  const [containerWidth, setContainerWidth] = useState(0);

  useLayoutEffect(() => {
    const el = itemContainerRef.current;
    if (!el) return;
    setContainerWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [itemContainerRef]);

  return containerWidth;
}

export function usePretextWarmup(groupedItems: RenderItem[], fontConfig: FontConfig) {
  useEffect(() => {
    let cancelled = false;
    const { proseFont } = fontConfig;

    const runPrepare = () => {
      if (cancelled) return;
      ensurePretextLoaded().then(() => {
        if (cancelled) return;

        const toPrepare: string[] = [];
        for (const item of groupedItems) {
          if (item.type !== 'message' || !item.msg.content) continue;

          const text =
            item.msg.role === 'user'
              ? parseReferencedFiles(item.msg.content).inlineContent.trim()
              : analyzeMarkdown(item.msg.content.trim()).plainText;
          if (text && !getCachedPrepared(text, proseFont)) {
            toPrepare.push(text);
          }
        }

        if (toPrepare.length > 0) {
          prepareBatch(toPrepare, proseFont, {
            signal: cancelled ? AbortSignal.abort() : undefined,
          });
        }
      });
    };

    // Defer off the thread-switch commit so pretext layout work does not
    // extend INP on the click that mounted this list.
    const idleId =
      typeof requestIdleCallback === 'function'
        ? requestIdleCallback(runPrepare, { timeout: 2000 })
        : (setTimeout(runPrepare, 0) as unknown as number);

    return () => {
      cancelled = true;
      if (typeof cancelIdleCallback === 'function') {
        cancelIdleCallback(idleId);
      } else {
        clearTimeout(idleId);
      }
    };
  }, [groupedItems, fontConfig]);
}
