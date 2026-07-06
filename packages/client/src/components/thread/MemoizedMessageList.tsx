import { useVirtualizer } from '@tanstack/react-virtual';
import {
  useState,
  useRef,
  useEffectEvent,
  useLayoutEffect,
  useCallback,
  useMemo,
  memo,
  useImperativeHandle,
} from 'react';
import { useTranslation } from 'react-i18next';

import { makeProseFont } from '@/hooks/use-pretext';
import { buildGroupedRenderItems, findNearestPrecedingUserMessageItem } from '@/lib/render-items';
import {
  useSettingsStore,
  PROSE_FONT_SIZE_PX,
  PROSE_LINE_HEIGHT_PX,
  CODE_LINE_HEIGHT_PX,
} from '@/stores/settings-store';

import {
  useContainerWidth,
  useListScrollMargin,
  usePretextWarmup,
} from './MemoizedMessageList.hooks';
import {
  buildFallbackVirtualItems,
  estimateItemHeight,
  estimateVirtualRowHeight,
  getElementBottomRelativeToContainer,
  getMeasuredLastRowBottom,
  getObservedBlockSize,
  getVirtualContentHeight,
  shouldAdjustScrollPositionOnItemSizeChange,
  VIRTUAL_OVERSCAN,
  VIRTUAL_ROW_GAP_PX,
  type FontConfig,
} from './MemoizedMessageList.measurement';
import { UserMessageRenderer, VirtualRowContent } from './MemoizedMessageList.renderers';
import type {
  MemoizedMessageListProps,
  MessageListScrollAnchor,
} from './MemoizedMessageList.types';
import {
  buildItemIndexMap,
  buildRowKeyIndexMap,
  buildUserRowVirtualIndices,
  buildVirtualRows,
  getLeadingUserItem,
  getVirtualRowsSignature,
  shouldReserveLeadingStickySpace,
} from './MemoizedMessageList.virtualRows';
export type {
  MemoizedMessageListHandle,
  MemoizedMessageListProps,
  MessageListScrollAnchor,
} from './MemoizedMessageList.types';

const STICKY_SECTION_VISIBILITY_EPSILON_PX = 1;

/** Custom comparator for MemoizedMessageList — avoids re-renders when only
 *  unrelated activeThread properties changed (cost, contextUsage, etc.).
 *  NOTE: threadStatus IS included because tool cards like AskUserQuestion and
 *  ExitPlanMode conditionally render the "Respond" button based on whether the
 *  thread is in 'waiting' status. Without this, the button won't appear when
 *  agent:status arrives after the tool_call event. */
function messageListAreEqual(prev: MemoizedMessageListProps, next: MemoizedMessageListProps) {
  return (
    prev.ref === next.ref &&
    prev.messages === next.messages &&
    prev.leadingUserMessage === next.leadingUserMessage &&
    prev.threadEvents === next.threadEvents &&
    prev.compactionEvents === next.compactionEvents &&
    prev.threadId === next.threadId &&
    prev.sessionChanges === next.sessionChanges &&
    prev.changeSummaryRunning === next.changeSummaryRunning &&
    prev.onSessionReverted === next.onSessionReverted &&
    (prev.threadStatus === 'waiting') === (next.threadStatus === 'waiting') &&
    prev.snapshotMap === next.snapshotMap &&
    prev.onSend === next.onSend &&
    prev.onOpenLightbox === next.onOpenLightbox &&
    prev.onToolRespond === next.onToolRespond &&
    prev.onFork === next.onFork &&
    prev.onRewind === next.onRewind &&
    prev.onForkAndRewind === next.onForkAndRewind &&
    prev.forkingMessageId === next.forkingMessageId &&
    prev.rewindDisabled === next.rewindDisabled &&
    prev.rewindDisabledReason === next.rewindDisabledReason &&
    prev.scrollRef === next.scrollRef
  );
}

/** Memoized message list with true virtualization over loaded grouped items. */
export const MemoizedMessageList = memo(
  // eslint-disable-next-line max-lines-per-function, react-doctor/no-giant-component -- Legacy virtualized renderer; this pass only extracts measurement and row helpers.
  function MemoizedMessageList({
    ref,
    messages,
    leadingUserMessage,
    threadEvents,
    compactionEvents,
    threadId,
    threadStatus,
    knownIds: _knownIds,
    snapshotMap,
    onSend,
    onOpenLightbox,
    onToolRespond,
    onFork,
    onRewind,
    onForkAndRewind,
    forkingMessageId,
    rewindDisabled,
    rewindDisabledReason,
    scrollRef,
    sessionChanges,
    changeSummaryRunning,
    onSessionReverted,
  }: MemoizedMessageListProps) {
    const { t } = useTranslation();
    // ── Font config: dynamic based on global font size setting ──
    const globalFontSize = useSettingsStore((s) => s.fontSize);
    const fontConfig = useMemo<FontConfig>(
      () => ({
        proseFont: makeProseFont(PROSE_FONT_SIZE_PX[globalFontSize]),
        proseLineHeight: PROSE_LINE_HEIGHT_PX[globalFontSize],
        codeLineHeight: CODE_LINE_HEIGHT_PX[globalFontSize],
      }),
      [globalFontSize],
    );

    const isWaiting = threadStatus === 'waiting';

    const groupedItems = useMemo(
      () => buildGroupedRenderItems(messages, threadEvents, compactionEvents),
      [messages, threadEvents, compactionEvents],
    );
    const leadingUserItem = useMemo(
      () => getLeadingUserItem(leadingUserMessage, messages),
      [leadingUserMessage, messages],
    );

    /* ── Virtualized rendering ─────────────────────────────────────── */

    const heightCacheRef = useRef<Map<string, number> | null>(null);
    if (heightCacheRef.current === null) {
      heightCacheRef.current = new Map();
    }
    const heightCache = heightCacheRef.current;
    const measuredRowBottomCacheRef = useRef<Map<string, number> | null>(null);
    if (measuredRowBottomCacheRef.current === null) {
      measuredRowBottomCacheRef.current = new Map();
    }
    const measuredRowBottomCache = measuredRowBottomCacheRef.current;
    const [measuredContentBottom, setMeasuredContentBottom] = useState(0);
    const itemContainerRef = useRef<HTMLDivElement>(null);
    const stickySectionContentRef = useRef<HTMLDivElement>(null);
    const listScrollMargin = useListScrollMargin(scrollRef, itemContainerRef);
    const [measuredLeadingStickyHeight, setMeasuredLeadingStickyHeight] = useState(0);

    // ── Container width for pretext estimation ───────────────────────
    const containerWidth = useContainerWidth(itemContainerRef);

    const layoutKey = `${threadId}:${globalFontSize}:${Math.round(containerWidth)}`;
    const prevLayoutKeyRef = useRef(layoutKey);
    if (prevLayoutKeyRef.current !== layoutKey) {
      prevLayoutKeyRef.current = layoutKey;
      heightCache.clear();
      measuredRowBottomCache.clear();
      if (measuredContentBottom !== 0) setMeasuredContentBottom(0);
    }

    const rowBottomKey = `${threadId}:${Math.round(listScrollMargin)}`;
    const prevRowBottomKeyRef = useRef(rowBottomKey);
    if (prevRowBottomKeyRef.current !== rowBottomKey) {
      prevRowBottomKeyRef.current = rowBottomKey;
      measuredRowBottomCache.clear();
      if (measuredContentBottom !== 0) setMeasuredContentBottom(0);
    }

    usePretextWarmup(groupedItems, fontConfig);

    const virtualRows = useMemo(
      () => buildVirtualRows(groupedItems, sessionChanges),
      [groupedItems, sessionChanges],
    );
    const virtualRowsSignature = useMemo(() => getVirtualRowsSignature(virtualRows), [virtualRows]);
    const shouldReserveLeadingStickySpaceValue = shouldReserveLeadingStickySpace(
      leadingUserItem,
      virtualRows[0],
    );
    const estimatedLeadingStickySpacerHeight = useMemo(() => {
      if (!leadingUserItem) return 0;
      return estimateItemHeight(leadingUserItem, containerWidth, fontConfig) + VIRTUAL_ROW_GAP_PX;
    }, [containerWidth, fontConfig, leadingUserItem]);
    const leadingStickySpacerHeight = shouldReserveLeadingStickySpaceValue
      ? Math.max(measuredLeadingStickyHeight, estimatedLeadingStickySpacerHeight)
      : 0;

    const rowKeyIndexMap = useMemo(() => buildRowKeyIndexMap(virtualRows), [virtualRows]);
    const userRowVirtualIndices = useMemo(
      () => buildUserRowVirtualIndices(virtualRows),
      [virtualRows],
    );
    const itemIndexMap = useMemo(
      () => buildItemIndexMap(groupedItems, virtualRows),
      [groupedItems, virtualRows],
    );

    const rowVirtualizer = useVirtualizer({
      count: virtualRows.length,
      getScrollElement: () => scrollRef.current,
      getItemKey: (index) => virtualRows[index]?.key ?? index,
      estimateSize: (index) => {
        const row = virtualRows[index];
        return (
          heightCache.get(row?.key ?? '') ??
          estimateVirtualRowHeight(row, containerWidth, fontConfig)
        );
      },
      gap: VIRTUAL_ROW_GAP_PX,
      overscan: VIRTUAL_OVERSCAN,
      scrollMargin: listScrollMargin,
      measureElement: (element, entry) => {
        const key = (element as HTMLElement).dataset.virtualRowKey;
        const height =
          getObservedBlockSize(entry) ?? (element as HTMLElement).getBoundingClientRect().height;
        if (key && height > 0) {
          heightCache.set(key, height);

          const bottom = getElementBottomRelativeToContainer(
            element as HTMLElement,
            itemContainerRef.current,
          );
          if (bottom !== undefined && bottom > 0) {
            measuredRowBottomCache.set(key, bottom);
            let nextMeasuredBottom = 0;
            measuredRowBottomCache.forEach((value) => {
              nextMeasuredBottom = Math.max(nextMeasuredBottom, value);
            });
            setMeasuredContentBottom((prev) =>
              Math.abs(prev - nextMeasuredBottom) > 1 ? nextMeasuredBottom : prev,
            );
          }
        }
        return height;
      },
    });
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange =
      shouldAdjustScrollPositionOnItemSizeChange;

    const measureRowsEvent = useEffectEvent(() => {
      rowVirtualizer.measure();
    });

    useLayoutEffect(() => {
      let secondRafId: number | null = null;
      const firstRafId = requestAnimationFrame(() => {
        measureRowsEvent();
        secondRafId = requestAnimationFrame(measureRowsEvent);
      });

      return () => {
        cancelAnimationFrame(firstRafId);
        if (secondRafId !== null) cancelAnimationFrame(secondRafId);
      };
    }, [containerWidth, globalFontSize, listScrollMargin, threadId, virtualRowsSignature]);

    const virtualItems = rowVirtualizer.getVirtualItems();
    const shouldUseVirtualFallback = virtualItems.length === 0 && virtualRows.length > 0;
    const fallbackVirtualItems = useMemo(
      () =>
        shouldUseVirtualFallback
          ? buildFallbackVirtualItems(virtualRows, heightCache, containerWidth, fontConfig)
          : [],
      [containerWidth, fontConfig, heightCache, shouldUseVirtualFallback, virtualRows],
    );
    const visibleVirtualItems = shouldUseVirtualFallback ? fallbackVirtualItems : virtualItems;
    const fallbackContentHeight = fallbackVirtualItems.at(-1)?.end ?? 0;
    const lastRow = virtualRows.at(-1);
    const lastVirtualItem = visibleVirtualItems.find(
      (virtualItem) => virtualItem.index === virtualRows.length - 1,
    );
    const measuredLastRowBottom = getMeasuredLastRowBottom({
      heightCache,
      lastVirtualItem,
      lastRow,
      leadingStickySpacerHeight,
      listScrollMargin,
    });
    const virtualContentHeight = getVirtualContentHeight({
      fallbackContentHeight,
      leadingStickySpacerHeight,
      measuredContentBottom,
      measuredLastRowBottom,
      virtualizerTotalSize: rowVirtualizer.getTotalSize(),
    });

    // ── Scroll anchor: capture/restore for jank-free scroll preservation ──
    const scrollAnchorRef = useRef<MessageListScrollAnchor | null>(null);

    const captureVisibleAnchor = useCallback(() => {
      const viewport = scrollRef.current;
      const container = itemContainerRef.current;
      if (!viewport || !container) return null;

      const vpRect = viewport.getBoundingClientRect();
      const rows = container.querySelectorAll<HTMLElement>('[data-virtual-row-key]');
      for (const row of rows) {
        const rect = row.getBoundingClientRect();
        if (rect.bottom > vpRect.top) {
          return {
            key: row.dataset.virtualRowKey!,
            offsetFromViewportTop: rect.top - vpRect.top,
          };
        }
      }
      return null;
    }, [scrollRef]);

    const captureScrollAnchor = useCallback(() => {
      scrollAnchorRef.current = captureVisibleAnchor();
    }, [captureVisibleAnchor]);

    const restoreScrollAnchor = useCallback(
      (providedAnchor?: MessageListScrollAnchor) => {
        const viewport = scrollRef.current;
        const container = itemContainerRef.current;
        const anchor = providedAnchor ?? scrollAnchorRef.current;
        if (!viewport || !container || !anchor) return false;

        const applyDrift = () => {
          const el = container.querySelector<HTMLElement>(
            `[data-virtual-row-key="${CSS.escape(anchor.key)}"]`,
          );
          if (!el) return false;
          const vpRect = viewport.getBoundingClientRect();
          const rect = el.getBoundingClientRect();
          const currentOffset = rect.top - vpRect.top;
          const drift = currentOffset - anchor.offsetFromViewportTop;
          viewport.scrollTop += drift;
          return true;
        };

        if (applyDrift()) {
          if (!providedAnchor) scrollAnchorRef.current = null;
          return true;
        }

        const index = rowKeyIndexMap.get(anchor.key);
        if (index === undefined) {
          if (!providedAnchor) scrollAnchorRef.current = null;
          return false;
        }
        const offsetForIndex = rowVirtualizer.getOffsetForIndex(index, 'start')?.[0];
        if (typeof offsetForIndex === 'number') {
          rowVirtualizer.scrollToOffset(
            Math.max(0, offsetForIndex + leadingStickySpacerHeight - anchor.offsetFromViewportTop),
            { align: 'start' },
          );
        } else {
          rowVirtualizer.scrollToIndex(index, { align: 'start' });
        }
        requestAnimationFrame(() => {
          applyDrift();
          if (!providedAnchor) scrollAnchorRef.current = null;
        });
        return true;
      },
      [leadingStickySpacerHeight, rowKeyIndexMap, rowVirtualizer, scrollRef],
    );

    const stickyScrollOffset =
      rowVirtualizer.scrollOffset ?? scrollRef.current?.scrollTop ?? listScrollMargin;
    const firstVisibleVirtualItem =
      visibleVirtualItems.find((virtualItem) => virtualItem.end > stickyScrollOffset) ??
      visibleVirtualItems[0];
    const firstVisibleRow = firstVisibleVirtualItem
      ? virtualRows[firstVisibleVirtualItem.index]
      : undefined;
    const candidateHiddenSectionUserItem = useMemo(() => {
      if (!firstVisibleRow || !firstVisibleVirtualItem) return null;
      if (firstVisibleRow.type === 'session-summary') return firstVisibleRow.userItem;
      if (firstVisibleRow.item.type === 'message' && firstVisibleRow.item.msg.role === 'user') {
        // The real user card is still the first visible row. Showing the sticky
        // copy here creates a duplicate until the virtualizer catches up.
        return null;
      }
      return (
        findNearestPrecedingUserMessageItem(groupedItems, firstVisibleRow.itemIndex) ??
        leadingUserItem
      );
    }, [firstVisibleRow, firstVisibleVirtualItem, groupedItems, leadingUserItem]);
    const [visibleMountedSectionUserId, setVisibleMountedSectionUserId] = useState<string | null>(
      null,
    );

    const updateMountedSectionVisibility = useCallback(() => {
      const candidateId = candidateHiddenSectionUserItem?.msg.id;
      if (!candidateId) {
        setVisibleMountedSectionUserId((prev) => (prev === null ? prev : null));
        return;
      }

      const viewport = scrollRef.current;
      const container = itemContainerRef.current;
      if (!viewport || !container) {
        setVisibleMountedSectionUserId((prev) => (prev === null ? prev : null));
        return;
      }

      const section = container.querySelector<HTMLElement>(
        `[data-section-msg-id="${CSS.escape(candidateId)}"]`,
      );
      if (!section) {
        setVisibleMountedSectionUserId((prev) => (prev === null ? prev : null));
        return;
      }

      const viewportRect = viewport.getBoundingClientRect();
      const sectionRect = section.getBoundingClientRect();
      const isVisible =
        sectionRect.bottom > viewportRect.top + STICKY_SECTION_VISIBILITY_EPSILON_PX &&
        sectionRect.top < viewportRect.bottom - STICKY_SECTION_VISIBILITY_EPSILON_PX;
      const next = isVisible ? candidateId : null;
      setVisibleMountedSectionUserId((prev) => (prev === next ? prev : next));
    }, [candidateHiddenSectionUserItem?.msg.id, scrollRef]);

    useLayoutEffect(() => {
      updateMountedSectionVisibility();
    }, [stickyScrollOffset, updateMountedSectionVisibility]);

    const hiddenSectionUserItem =
      candidateHiddenSectionUserItem &&
      visibleMountedSectionUserId !== candidateHiddenSectionUserItem.msg.id
        ? candidateHiddenSectionUserItem
        : null;

    const [stickyContentHeight, setStickyContentHeight] = useState(0);
    useLayoutEffect(() => {
      const el = stickySectionContentRef.current;
      if (!el) {
        setStickyContentHeight((prev) => (prev === 0 ? prev : 0));
        return;
      }
      const measure = () => {
        const next = el.getBoundingClientRect().height;
        setStickyContentHeight((prev) => (Math.abs(prev - next) > 1 ? next : prev));
      };
      measure();
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
      // eslint-disable-next-line react-hooks/exhaustive-deps, react-doctor/exhaustive-deps
    }, [hiddenSectionUserItem?.msg.id]);

    // Smooth section handoff: as the next section's user card scrolls up to
    // meet the docked sticky copy, push the copy out of the viewport instead
    // of letting the incoming card slide underneath it and swap with a pop.
    let stickyPushPx = 0;
    if (hiddenSectionUserItem && firstVisibleVirtualItem && stickyContentHeight > 0) {
      const nextUserRowIndex = userRowVirtualIndices.find(
        (index) => index >= firstVisibleVirtualItem.index,
      );
      if (nextUserRowIndex !== undefined) {
        const nextUserRowStart =
          visibleVirtualItems.find((item) => item.index === nextUserRowIndex)?.start ??
          rowVirtualizer.getOffsetForIndex(nextUserRowIndex, 'start')?.[0];
        if (typeof nextUserRowStart === 'number') {
          const nextUserRowViewportTop =
            nextUserRowStart + leadingStickySpacerHeight - stickyScrollOffset;
          stickyPushPx = Math.min(0, Math.round(nextUserRowViewportTop - stickyContentHeight));
        }
      }
    }

    useLayoutEffect(() => {
      if (!shouldReserveLeadingStickySpaceValue) {
        setMeasuredLeadingStickyHeight((prev) => (prev === 0 ? prev : 0));
        return;
      }

      const el = stickySectionContentRef.current;
      if (!el) return;

      const measure = () => {
        const next = el.getBoundingClientRect().height + VIRTUAL_ROW_GAP_PX;
        setMeasuredLeadingStickyHeight((prev) => (Math.abs(prev - next) > 1 ? next : prev));
      };

      measure();
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }, [shouldReserveLeadingStickySpaceValue, hiddenSectionUserItem?.msg.id]);

    useImperativeHandle(
      ref,
      () => ({
        expandToItem: (id: string) => {
          const index = itemIndexMap.get(id);
          if (index !== undefined) {
            rowVirtualizer.scrollToIndex(index, { align: 'center' });
          }
        },
        hasHiddenItems: () => (rowVirtualizer.getVirtualItems()[0]?.index ?? 0) > 0,
        captureScrollAnchor,
        restoreScrollAnchor,
        captureVisibleAnchor,
      }),
      [
        itemIndexMap,
        rowVirtualizer,
        captureScrollAnchor,
        restoreScrollAnchor,
        captureVisibleAnchor,
      ],
    );

    const measureVirtualRowElement = useCallback(
      (element: Element | null) => {
        if (!element) return;
        rowVirtualizer.measureElement(element);
        updateMountedSectionVisibility();
      },
      [rowVirtualizer, updateMountedSectionVisibility],
    );

    const scrollToUserMessagePosition = useCallback(
      (msgId: string) => {
        const viewport = scrollRef.current;
        if (!viewport) return;

        const scrollToMountedSection = () => {
          const section = viewport.querySelector(`[data-section-msg-id="${msgId}"]`);
          if (!section) return false;

          const viewportRect = viewport.getBoundingClientRect();
          const sectionRect = section.getBoundingClientRect();
          // Bring the real card's top to the top of the viewport.
          const desiredTop = viewport.scrollTop + (sectionRect.top - viewportRect.top);

          // …but never scroll past the point where the real message content
          // (everything except the sticky bottom prompt dock) still reaches the
          // viewport bottom. Otherwise a short final section gets yanked all the
          // way up, exposing the empty area above the pinned prompt input.
          const content = itemContainerRef.current?.parentElement;
          const maxUsefulTop = content
            ? viewport.scrollTop + (content.getBoundingClientRect().bottom - viewportRect.bottom)
            : desiredTop;

          viewport.scrollTo({
            top: Math.max(0, Math.min(desiredTop, maxUsefulTop)),
            behavior: 'smooth',
          });
          return true;
        };

        if (scrollToMountedSection()) return;

        const index = itemIndexMap.get(msgId);
        if (index === undefined) return;

        rowVirtualizer.scrollToIndex(index, { align: 'start' });
        requestAnimationFrame(scrollToMountedSection);
      },
      [itemIndexMap, rowVirtualizer, scrollRef],
    );

    return (
      <div
        ref={itemContainerRef}
        style={{
          height: `${virtualContentHeight}px`,
          position: 'relative',
          width: '100%',
          overflowAnchor: 'none',
          isolation: 'isolate',
        }}
      >
        {hiddenSectionUserItem ? (
          <div
            key={hiddenSectionUserItem.msg.id}
            data-testid="sticky-section-context"
            className="pointer-events-none sticky top-0 z-50 h-0"
          >
            <div
              ref={stickySectionContentRef}
              data-testid="sticky-section-content"
              className="pointer-events-auto relative z-50 pt-3 pb-3"
              style={stickyPushPx < 0 ? { transform: `translateY(${stickyPushPx}px)` } : undefined}
            >
              <UserMessageRenderer
                item={hiddenSectionUserItem}
                includeItemKey={false}
                includeUserObserver={false}
                onOpenLightbox={onOpenLightbox}
                onFork={onFork}
                onRewind={onRewind}
                onForkAndRewind={onForkAndRewind}
                forkingMessageId={forkingMessageId}
                rewindDisabled={rewindDisabled}
                rewindDisabledReason={rewindDisabledReason}
                scrollToUserMessagePosition={scrollToUserMessagePosition}
              />
            </div>
          </div>
        ) : null}
        {visibleVirtualItems.map((virtualItem) => {
          const row = virtualRows[virtualItem.index];
          if (!row) return null;

          return (
            <div
              ref={measureVirtualRowElement}
              data-index={virtualItem.index}
              data-virtual-row-key={row.key}
              {...(row.type === 'item' &&
              row.item.type === 'message' &&
              row.item.msg.role === 'user'
                ? { 'data-section-msg-id': row.item.msg.id }
                : {})}
              key={virtualItem.key}
              className="absolute top-0 left-0 z-0 w-full"
              style={{
                transform: `translateY(${
                  virtualItem.start - listScrollMargin + leadingStickySpacerHeight
                }px)`,
                overflowAnchor: 'none',
              }}
            >
              <VirtualRowContent
                row={row}
                t={t}
                threadId={threadId}
                changeSummaryRunning={changeSummaryRunning}
                onSessionReverted={onSessionReverted}
                snapshotMap={snapshotMap}
                isWaiting={isWaiting}
                onSend={onSend}
                onToolRespond={onToolRespond}
                onOpenLightbox={onOpenLightbox}
                onFork={onFork}
                onRewind={onRewind}
                onForkAndRewind={onForkAndRewind}
                forkingMessageId={forkingMessageId}
                rewindDisabled={rewindDisabled}
                rewindDisabledReason={rewindDisabledReason}
                scrollToUserMessagePosition={scrollToUserMessagePosition}
              />
            </div>
          );
        })}
      </div>
    );
  },
  messageListAreEqual,
);
