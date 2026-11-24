import type { ThreadEvent } from '@funny/shared';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import type { RefObject } from 'react';
import { flushSync } from 'react-dom';

import { useFactoryTimelineCards } from '@/hooks/use-factory-timeline-cards';
import {
  ensurePretextLoaded,
  getCachedPrepared,
  makeProseFont,
  prepareBatch,
} from '@/hooks/use-pretext';
import { useStableCallback } from '@/hooks/use-stable-callback';
import { analyzeMarkdown } from '@/lib/markdown-to-plaintext';
import { parseReferencedFiles } from '@/lib/parse-referenced-files';
import { buildGroupedRenderItems, type RenderItem } from '@/lib/render-items';
import {
  useSettingsStore,
  PROSE_FONT_SIZE_PX,
  PROSE_LINE_HEIGHT_PX,
  CODE_LINE_HEIGHT_PX,
  type FontSize,
} from '@/stores/settings-store';
import type { CompactionEvent } from '@/stores/thread-store';

import type { FontConfig } from './MemoizedMessageList.measurement';

/** What `useListFontConfig` returns. */
interface ListFontConfig {
  fontSize: FontSize;
  fontConfig: FontConfig;
}

/** The user's font size and the fonts a message list measures text with. */
export function useListFontConfig(): ListFontConfig {
  const fontSize = useSettingsStore((s) => s.fontSize);
  const fontConfig = useMemo<FontConfig>(
    () => ({
      proseFont: makeProseFont(PROSE_FONT_SIZE_PX[fontSize]),
      proseLineHeight: PROSE_LINE_HEIGHT_PX[fontSize],
      codeLineHeight: CODE_LINE_HEIGHT_PX[fontSize],
    }),
    [fontSize],
  );
  return { fontSize, fontConfig };
}

/**
 * The list's render items; the thread status decides whether its latest stop
 * gets a row. A factory thread's run cards (proof, failure) sit among them by
 * time.
 */
export function useGroupedRenderItems(
  messages: any[],
  threadEvents: ThreadEvent[] | undefined,
  compactionEvents: CompactionEvent[] | undefined,
  threadStatus: string | undefined,
  threadId: string | undefined,
): RenderItem[] {
  const factoryCards = useFactoryTimelineCards(threadId, threadStatus === 'running');
  return useMemo(
    () =>
      buildGroupedRenderItems(messages, threadEvents, compactionEvents, threadStatus, factoryCards),
    [messages, threadEvents, compactionEvents, threadStatus, factoryCards],
  );
}

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
  const updateListScrollMarginEvent = useStableCallback(updateListScrollMargin);

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
  }, [itemContainerRef, scrollRef, updateListScrollMarginEvent]);

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

/**
 * Prepares the list's texts for pretext in idle time. `onPrepared` runs after
 * a batch that prepared at least one text, which is when a text estimate can
 * change.
 */
export function usePretextWarmup(
  groupedItems: RenderItem[],
  fontConfig: FontConfig,
  onPrepared?: () => void,
) {
  const notifyPrepared = useStableCallback(() => onPrepared?.());

  // The effect cleanup cancels the idle callback or fallback timeout and gates the pending promise.
  // react-doctor-disable-next-line effect-needs-cleanup
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
          // Not gated on `cancelled`: a newer run finds these texts already
          // prepared and would never report them.
          void prepareBatch(toPrepare, proseFont, {
            signal: cancelled ? AbortSignal.abort() : undefined,
          }).then((prepared) => {
            if (prepared > 0) notifyPrepared();
          });
        }
      });
    };

    // Defer off the thread-switch commit so pretext layout work does not
    // extend INP on the click that mounted this list.
    const idleId =
      typeof requestIdleCallback === 'function'
        ? requestIdleCallback(runPrepare, { timeout: 2000 })
        : // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- source and target types do not overlap, so TS needs the unknown step
          (setTimeout(runPrepare, 0) as unknown as number);

    return () => {
      cancelled = true;
      if (typeof cancelIdleCallback === 'function') {
        cancelIdleCallback(idleId);
      } else {
        clearTimeout(idleId);
      }
    };
  }, [groupedItems, fontConfig, notifyPrepared]);
}

/** Sync renders allowed per frame before falling back to React's own schedule. */
const MAX_SYNC_RENDERS_PER_FRAME = 8;

/**
 * Returns the virtualizer's `onChange`. When the virtualizer measures a row
 * above the viewport it moves the scroll position at once, inside its
 * ResizeObserver callback, but the rows only move on the next React commit.
 * React schedules that commit as a task, so the browser painted one frame with
 * the scroll moved and the rows not: the content was shown displaced by the
 * row's estimate error, then put back. Rendering in a microtask puts the commit
 * before that paint.
 *
 * `scrollTopAtLastScrollEventRef` tells a moved scroll position from a row that
 * only resized: a position no scroll event has reported yet was set by code.
 */
export function useSyncRenderOnScrollCorrection(
  scrollRef: RefObject<HTMLElement | null>,
  scrollTopAtLastScrollEventRef: RefObject<number | null>,
) {
  const [, renderNow] = useReducer((count: number) => count + 1, 0);
  const scheduledRef = useRef(false);
  const rendersThisFrameRef = useRef(0);

  return useCallback(
    (_instance: unknown, isScrollNotification: boolean) => {
      // Scroll notifications keep React's schedule, so mounting rows never
      // blocks the scroll handler.
      if (isScrollNotification || scheduledRef.current) return;
      const viewport = scrollRef.current;
      if (!viewport || viewport.scrollTop === scrollTopAtLastScrollEventRef.current) return;

      scheduledRef.current = true;
      queueMicrotask(() => {
        scheduledRef.current = false;
        // A row whose size depends on the render would otherwise loop here
        // without ever yielding to the browser.
        if (rendersThisFrameRef.current >= MAX_SYNC_RENDERS_PER_FRAME) return;
        if (rendersThisFrameRef.current === 0) {
          requestAnimationFrame(() => {
            rendersThisFrameRef.current = 0;
          });
        }
        rendersThisFrameRef.current += 1;
        flushSync(renderNow);
      });
    },
    [scrollRef, scrollTopAtLastScrollEventRef],
  );
}
