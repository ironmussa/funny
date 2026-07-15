import { useCallback, useImperativeHandle, useMemo, useRef, memo, type CSSProperties } from 'react';

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
import { UserMessageRenderer, VirtualRowContent } from './MemoizedMessageList.renderers';
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
  lastUserMessage,
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

  // A restored long-thread window can sit before the newest user prompt. Keep
  // that prompt in a separate sticky card until its real row arrives through
  // newer-message pagination; otherwise frozen mode loses the user's current
  // question entirely.
  const detachedLastUserItem = useMemo(() => {
    if (
      !lastUserMessage ||
      lastUserMessage.role !== 'user' ||
      messages.some((message) => message.id === lastUserMessage.id)
    ) {
      return null;
    }
    return { type: 'message' as const, msg: lastUserMessage };
  }, [lastUserMessage, messages]);

  // Group rows into sections, each starting at a user message. The sticky
  // header (§6.7) lives INSIDE its section container, so it is bounded by that
  // section: when the section scrolls out the header goes with it and the next
  // section's header takes the top. A flat list of sibling stickies instead
  // piles every header at top:0 (they share one containing block) — the stacking
  // bug. Rows before the first user message form a headerless leading section.
  const sections = useMemo(() => {
    const out: { key: string; rows: typeof virtualRows }[] = [];
    let current: { key: string; rows: typeof virtualRows } | null = null;
    for (const row of virtualRows) {
      const isUserRow =
        row.type === 'item' && row.item.type === 'message' && row.item.msg.role === 'user';
      if (isUserRow || current === null) {
        current = { key: row.key, rows: [row] };
        out.push(current);
      } else {
        current.rows.push(row);
      }
    }
    return out;
  }, [virtualRows]);

  const renderRow = (row: (typeof virtualRows)[number]) => {
    const isUserRow =
      row.type === 'item' && row.item.type === 'message' && row.item.msg.role === 'user';
    const estimate = Math.round(estimateVirtualRowHeight(row, containerWidth, fontConfig));
    const rowStyle: CSSProperties = isUserRow
      ? {
          position: 'sticky',
          top: 0,
          zIndex: 20,
          overflowAnchor: 'auto',
          // Own paint layer: avoids a trailing ghost of the stuck header when
          // neighboring content-visibility rows repaint during scroll.
          transform: 'translateZ(0)',
        }
      : {
          contentVisibility: 'auto',
          containIntrinsicSize: `auto ${estimate}px`,
          overflowAnchor: 'auto',
        };
    return (
      <div
        key={row.key}
        data-virtual-row-key={row.key}
        {...(isUserRow ? { 'data-section-msg-id': (row as any).item.msg.id } : {})}
        // Opaque bg so content scrolling under the stuck header cannot bleed
        // through the transparent padding around the card.
        className={isUserRow ? 'bg-background' : undefined}
        style={rowStyle}
      >
        <VirtualRowContent
          row={row}
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
  };

  return (
    <FrozenViewerContext.Provider value={frozenCtxValue}>
      <div
        ref={containerRef}
        data-testid="frozen-message-list"
        style={{ display: 'flex', flexDirection: 'column', gap: `${VIRTUAL_ROW_GAP_PX}px` }}
      >
        {detachedLastUserItem ? (
          <div
            data-testid="frozen-last-user-context"
            data-section-msg-id={detachedLastUserItem.msg.id}
            className="bg-background"
            style={{
              position: 'sticky',
              top: 0,
              zIndex: 30,
              overflowAnchor: 'auto',
              transform: 'translateZ(0)',
            }}
          >
            <UserMessageRenderer
              item={detachedLastUserItem}
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
        ) : null}
        {sections.map((section) => (
          <div
            key={section.key}
            data-frozen-section=""
            style={{ display: 'flex', flexDirection: 'column', gap: `${VIRTUAL_ROW_GAP_PX}px` }}
          >
            {section.rows.map(renderRow)}
          </div>
        ))}
      </div>
    </FrozenViewerContext.Provider>
  );
});
