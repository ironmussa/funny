import { useCallback, useImperativeHandle, useMemo, useRef, memo } from 'react';
import { useTranslation } from 'react-i18next';

import { makeProseFont } from '@/hooks/use-pretext';
import { buildGroupedRenderItems } from '@/lib/render-items';
import {
  useSettingsStore,
  PROSE_FONT_SIZE_PX,
  PROSE_LINE_HEIGHT_PX,
  CODE_LINE_HEIGHT_PX,
} from '@/stores/settings-store';

import { FrozenViewerContext } from './frozen-message-context';
import { useContainerWidth, usePretextWarmup } from './MemoizedMessageList.hooks';
import {
  estimateVirtualRowHeight,
  VIRTUAL_ROW_GAP_PX,
  type FontConfig,
} from './MemoizedMessageList.measurement';
import { VirtualRowContent } from './MemoizedMessageList.renderers';
import type {
  MemoizedMessageListProps,
  MessageListScrollAnchor,
} from './MemoizedMessageList.types';
import { buildVirtualRows } from './MemoizedMessageList.virtualRows';

/**
 * Frozen viewer — in-flow list renderer (experimental `threadViewer=frozen`).
 *
 * Unlike `MemoizedMessageList` (absolute-positioned TanStack Virtual rows +
 * hand-rolled scroll anchoring), every loaded row is mounted in normal document
 * flow. Offscreen work is skipped by the browser via `content-visibility: auto`;
 * `contain-intrinsic-size: auto <estimate>` seeds a height and the `auto`
 * keyword makes the UA remember each row's real rendered size, so scrolling back
 * does not re-measure or jump. Because rows stay in flow, native
 * `overflow-anchor` keeps the position stable during prepends/streaming and
 * find-in-page (Ctrl+F) can reach offscreen rows — the whole point of the
 * frozen viewer.
 *
 * This reuses the existing per-row renderer (`VirtualRowContent`) and the same
 * imperative handle contract as the virtual list, so it drops into
 * `MessageStream` behind the flag with the surrounding chrome untouched. It also
 * provides `FrozenViewerContext`, which makes assistant markdown freeze to
 * static HTML offscreen (`FrozenMessage`) so memory stays bounded by the visible
 * rows. The sticky section header is still pending (§6.7).
 */
export const FrozenMessageList = memo(function FrozenMessageList({
  ref,
  messages,
  threadEvents,
  compactionEvents,
  threadId,
  threadStatus,
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
  const virtualRows = useMemo(
    () => buildVirtualRows(groupedItems, sessionChanges),
    [groupedItems, sessionChanges],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const containerWidth = useContainerWidth(containerRef);
  usePretextWarmup(groupedItems, fontConfig);

  // ── Scroll anchoring (native): capture the top-most visible row + its offset,
  // restore by nudging scrollTop so the same row lands at the same place. Shares
  // the `[data-virtual-row-key]` contract with the virtual list, so thread-switch
  // position restore wired through MessageStream works unchanged.
  const scrollAnchorRef = useRef<MessageListScrollAnchor | null>(null);

  const captureVisibleAnchor = useCallback((): MessageListScrollAnchor | null => {
    const viewport = scrollRef.current;
    const container = containerRef.current;
    if (!viewport || !container) return null;
    const vpTop = viewport.getBoundingClientRect().top;
    const rows = container.querySelectorAll<HTMLElement>('[data-virtual-row-key]');
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > vpTop) {
        return { key: row.dataset.virtualRowKey!, offsetFromViewportTop: rect.top - vpTop };
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
      const container = containerRef.current;
      const anchor = providedAnchor ?? scrollAnchorRef.current;
      if (!viewport || !container || !anchor) return false;
      const el = container.querySelector<HTMLElement>(
        `[data-virtual-row-key="${CSS.escape(anchor.key)}"]`,
      );
      if (!el) {
        if (!providedAnchor) scrollAnchorRef.current = null;
        return false;
      }
      const vpTop = viewport.getBoundingClientRect().top;
      const currentOffset = el.getBoundingClientRect().top - vpTop;
      viewport.scrollTop += currentOffset - anchor.offsetFromViewportTop;
      if (!providedAnchor) scrollAnchorRef.current = null;
      return true;
    },
    [scrollRef],
  );

  const scrollToRowByAttr = useCallback((attr: string, value: string) => {
    const el = containerRef.current?.querySelector<HTMLElement>(`[${attr}="${CSS.escape(value)}"]`);
    if (!el) return false;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return true;
  }, []);

  const scrollToUserMessagePosition = useCallback(
    (msgId: string) => {
      if (scrollToRowByAttr('data-section-msg-id', msgId)) return;
      scrollToRowByAttr('data-item-key', msgId);
    },
    [scrollToRowByAttr],
  );

  useImperativeHandle(
    ref,
    () => ({
      expandToItem: (id: string) => {
        if (scrollToRowByAttr('data-item-key', id)) return;
        scrollToRowByAttr('data-virtual-row-key', id);
      },
      hasHiddenItems: () => (scrollRef.current?.scrollTop ?? 0) > 0,
      captureScrollAnchor,
      restoreScrollAnchor,
      captureVisibleAnchor,
    }),
    [captureScrollAnchor, restoreScrollAnchor, captureVisibleAnchor, scrollToRowByAttr, scrollRef],
  );

  const frozenCtxValue = useMemo(() => ({ scrollRootRef: scrollRef }), [scrollRef]);

  return (
    <FrozenViewerContext.Provider value={frozenCtxValue}>
      <div
        ref={containerRef}
        data-testid="frozen-message-list"
        style={{ display: 'flex', flexDirection: 'column', gap: `${VIRTUAL_ROW_GAP_PX}px` }}
      >
        {virtualRows.map((row) => {
          const isUserRow =
            row.type === 'item' && row.item.type === 'message' && row.item.msg.role === 'user';
          const estimate = Math.round(estimateVirtualRowHeight(row, containerWidth, fontConfig));
          return (
            <div
              key={row.key}
              data-virtual-row-key={row.key}
              {...(isUserRow ? { 'data-section-msg-id': (row as any).item.msg.id } : {})}
              style={{
                contentVisibility: 'auto',
                containIntrinsicSize: `auto ${estimate}px`,
                overflowAnchor: 'auto',
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
    </FrozenViewerContext.Provider>
  );
});
