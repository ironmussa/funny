import type { FileDiffSummary, ThreadEvent } from '@funny/shared';
import { useVirtualizer, type VirtualItem, type Virtualizer } from '@tanstack/react-virtual';
import {
  useState,
  useRef,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useCallback,
  useMemo,
  memo,
  forwardRef,
  useImperativeHandle,
} from 'react';
import { useTranslation } from 'react-i18next';

import { useMinuteTick } from '@/hooks/use-minute-tick';
import {
  getCachedPrepared,
  isPretextReady,
  layoutSync,
  prepareBatch,
  makeProseFont,
  ensurePretextLoaded,
} from '@/hooks/use-pretext';
import { analyzeMarkdown } from '@/lib/markdown-to-plaintext';
import { parseReferencedFiles } from '@/lib/parse-referenced-files';
import {
  buildRenderItemIdIndexMap,
  buildGroupedRenderItems,
  findNearestPrecedingUserMessageItem,
  getItemKey,
  type ToolItem,
  type RenderItem,
} from '@/lib/render-items';
import { timeAgo } from '@/lib/thread-utils';
import { buildToolCallDiffFallbacks } from '@/lib/tool-call-diff-fallbacks';
import { cn } from '@/lib/utils';
import {
  useSettingsStore,
  PROSE_FONT_SIZE_PX,
  PROSE_LINE_HEIGHT_PX,
  CODE_LINE_HEIGHT_PX,
} from '@/stores/settings-store';
import type { CompactionEvent } from '@/stores/thread-store';

import { ToolCallCard } from '../ToolCallCard';
import { ToolCallGroup } from '../ToolCallGroup';
import { AuthorAvatar } from './AuthorAvatar';
import { ChangedFilesSummary } from './ChangedFilesSummary';
import { CompactionEventCard } from './CompactionEventCard';
import { GitEventCard } from './GitEventCard';
import { MessageContent, CopyButton } from './MessageContent';
import { UserMessageCard } from './UserMessageCard';
import { WorkflowEventGroup } from './WorkflowEventGroup';

const VIRTUAL_ROW_GAP_PX = 16;
const VIRTUAL_OVERSCAN = 8;
const STICKY_SECTION_VISIBILITY_EPSILON_PX = 1;
const USER_MESSAGE_ROW_PADDING_PX = 24;
const USER_MESSAGE_CARD_VERTICAL_CHROME_PX = 38;
const USER_MESSAGE_COLLAPSED_TEXT_PX = 48;
const USER_MESSAGE_EXPAND_BUTTON_PX = 20;
const USER_MESSAGE_ATTACHMENT_ROW_PX = 48;
const USER_MESSAGE_FILE_CHIP_ROW_PX = 28;
const USER_MESSAGE_MIN_ESTIMATE_PX = 112;

export const EMPTY_MESSAGES: any[] = [];

interface FontConfig {
  proseFont: string;
  proseLineHeight: number;
  codeLineHeight: number;
}

/**
 * Estimate item height. Message rows use pretext measurements when available,
 * then fall back to conservative estimates until ResizeObserver reports the
 * real row height.
 * containerWidth = 0 means "use flat fallback" (pretext not ready or width unknown).
 */
function estimatePlainTextHeight(text: string, containerWidth: number, fonts?: FontConfig): number {
  const lineHeight = fonts?.proseLineHeight ?? 20;
  if (!text) return lineHeight;

  if (containerWidth > 100 && isPretextReady() && fonts) {
    const prepared = getCachedPrepared(text, fonts.proseFont);
    if (prepared) {
      return layoutSync(prepared, containerWidth, fonts.proseLineHeight).height;
    }
  }

  const approxCharPx = 7;
  const textWidth = Math.max(120, containerWidth);
  return text.split('\n').reduce((height, line) => {
    const visualLines = Math.max(1, Math.ceil((line.length * approxCharPx) / textWidth));
    return height + visualLines * lineHeight;
  }, 0);
}

function estimateUserMessageHeight(msg: any, containerWidth: number, fonts?: FontConfig): number {
  const { files, inlineContent } = parseReferencedFiles(msg.content ?? '');
  const content = inlineContent.trim();
  const cardTextWidth = Math.max(120, containerWidth - 24);
  const fullTextHeight = estimatePlainTextHeight(content, cardTextWidth, fonts);
  const textHeight = Math.min(fullTextHeight, USER_MESSAGE_COLLAPSED_TEXT_PX);
  const expandButtonHeight =
    fullTextHeight > USER_MESSAGE_COLLAPSED_TEXT_PX ? USER_MESSAGE_EXPAND_BUTTON_PX : 0;

  const imageCount = msg.images?.length ?? 0;
  const imagesPerRow = Math.max(1, Math.floor(cardTextWidth / 104));
  const imageRows = imageCount > 0 ? Math.ceil(imageCount / imagesPerRow) : 0;
  const imageHeight = imageRows * USER_MESSAGE_ATTACHMENT_ROW_PX;

  const unmentionedFileCount = files.filter(
    (file) => !inlineContent.includes(`@${file.path}`),
  ).length;
  const chipsPerRow = Math.max(1, Math.floor(cardTextWidth / 160));
  const fileChipRows = unmentionedFileCount > 0 ? Math.ceil(unmentionedFileCount / chipsPerRow) : 0;
  const fileChipHeight = fileChipRows * USER_MESSAGE_FILE_CHIP_ROW_PX;

  return Math.max(
    USER_MESSAGE_MIN_ESTIMATE_PX,
    USER_MESSAGE_ROW_PADDING_PX +
      USER_MESSAGE_CARD_VERTICAL_CHROME_PX +
      imageHeight +
      fileChipHeight +
      textHeight +
      expandButtonHeight,
  );
}

function estimateAssistantMessageHeight(
  item: Extract<RenderItem, { type: 'message' }>,
  containerWidth: number,
  fonts?: FontConfig,
): number {
  const content = item.msg.content?.trim();
  if (content && containerWidth > 100 && isPretextReady() && fonts) {
    const analysis = analyzeMarkdown(content);
    const prepared = getCachedPrepared(analysis.plainText, fonts.proseFont);
    if (prepared) {
      // Effective text width: container minus avatar(32) + gap(8) + copyBtn(32) + gap(8) + padding(32)
      const textWidth = containerWidth - 112;
      const { height: proseHeight } = layoutSync(prepared, textWidth, fonts.proseLineHeight);
      // Code blocks: monospace lines + padding per block
      const codeHeight =
        analysis.codeBlockLines * fonts.codeLineHeight + analysis.codeBlockCount * 16;
      // Fixed chrome: timestamp(20px) + gap(8px)
      const totalHeight = proseHeight + codeHeight + analysis.extraHeightPx + 28;
      return Math.max(totalHeight, 60);
    }
  }
  return 120;
}

function estimateItemHeight(item: RenderItem, containerWidth = 0, fonts?: FontConfig): number {
  if (item.type === 'message') {
    if (item.msg.role === 'user') return estimateUserMessageHeight(item.msg, containerWidth, fonts);
    return estimateAssistantMessageHeight(item, containerWidth, fonts);
  }
  if (item.type === 'toolcall') return 44;
  if (item.type === 'toolcall-group') return 44;
  if (item.type === 'toolcall-run') return 44 * item.items.length;
  if (item.type === 'thread-event') return 32;
  if (item.type === 'compaction-event') return 32;
  if (item.type === 'workflow-event-group') return 32;
  return 60;
}

type MessageItem = Extract<RenderItem, { type: 'message' }>;

type VirtualRow =
  | {
      type: 'item';
      key: string;
      item: RenderItem;
      itemIndex: number;
    }
  | {
      type: 'session-summary';
      key: string;
      userItem: MessageItem;
      files: FileDiffSummary[];
      fallbackDiffs: Map<string, string>;
      isLastSection: boolean;
    };

type RenderUserMessageOptions = {
  includeItemKey?: boolean;
  includeUserObserver?: boolean;
};

function estimateVirtualRowHeight(
  row: VirtualRow | undefined,
  containerWidth: number,
  fonts: FontConfig,
) {
  if (!row) return 60;
  if (row.type === 'session-summary') return 72;
  return estimateItemHeight(row.item, containerWidth, fonts);
}

function getObservedBlockSize(entry: ResizeObserverEntry | undefined) {
  const size = entry?.borderBoxSize as
    | ResizeObserverSize
    | readonly ResizeObserverSize[]
    | undefined;
  if (!size) return undefined;
  return 'blockSize' in size ? size.blockSize : size[0]?.blockSize;
}

function getElementBottomRelativeToContainer(element: HTMLElement, container: HTMLElement | null) {
  if (!container) return undefined;
  if (!container.contains(element)) return undefined;
  const elementRect = element.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  return elementRect.bottom - containerRect.top;
}

function shouldAdjustScrollPositionOnItemSizeChange<
  TScrollElement extends Element | Window,
  TItemElement extends Element,
>(item: VirtualItem, _delta: number, instance: Virtualizer<TScrollElement, TItemElement>) {
  // TanStack keeps programmatic scroll state on the instance. Preserve those
  // adjustments for scrollToIndex/scrollToOffset, but avoid first-measurement
  // scrollTop writes while the user is actively scrolling by hand.
  const isProgrammaticScroll = Boolean(
    (instance as unknown as { scrollState?: unknown }).scrollState,
  );
  const isFirstMeasurement = !instance.itemSizeCache.has(item.key);

  if (isFirstMeasurement && instance.isScrolling && !isProgrammaticScroll) {
    return false;
  }

  return item.start < (instance.scrollOffset ?? 0);
}

export interface MemoizedMessageListHandle {
  expandToItem: (id: string) => void;
  hasHiddenItems: () => boolean;
  captureScrollAnchor: () => void;
  restoreScrollAnchor: (anchor?: MessageListScrollAnchor) => boolean;
  captureVisibleAnchor: () => MessageListScrollAnchor | null;
}

export interface MessageListScrollAnchor {
  key: string;
  offsetFromViewportTop: number;
}

/** Custom comparator for MemoizedMessageList — avoids re-renders when only
 *  unrelated activeThread properties changed (cost, contextUsage, etc.).
 *  NOTE: threadStatus IS included because tool cards like AskUserQuestion and
 *  ExitPlanMode conditionally render the "Respond" button based on whether the
 *  thread is in 'waiting' status. Without this, the button won't appear when
 *  agent:status arrives after the tool_call event. */
function messageListAreEqual(
  prev: {
    messages: any[];
    leadingUserMessage?: any;
    threadEvents?: any[];
    compactionEvents?: any[];
    threadId: string;
    threadStatus?: string;
    knownIds: Set<string>;
    prefersReducedMotion: boolean | null;
    snapshotMap: Map<string, number>;
    onSend: any;
    onOpenLightbox: any;
    onToolRespond?: any;
    onFork?: any;
    onRewind?: any;
    onForkAndRewind?: any;
    forkingMessageId?: string | null;
    rewindDisabled?: boolean;
    rewindDisabledReason?: string;
    scrollRef: any;
    sessionChanges?: Map<string, FileDiffSummary[]>;
    changeSummaryRunning?: boolean;
    onSessionReverted?: () => void;
  },
  next: typeof prev,
) {
  return (
    prev.messages === next.messages &&
    prev.leadingUserMessage === next.leadingUserMessage &&
    prev.threadEvents === next.threadEvents &&
    prev.compactionEvents === next.compactionEvents &&
    prev.threadId === next.threadId &&
    prev.sessionChanges === next.sessionChanges &&
    prev.changeSummaryRunning === next.changeSummaryRunning &&
    prev.onSessionReverted === next.onSessionReverted &&
    (prev.threadStatus === 'waiting') === (next.threadStatus === 'waiting') &&
    prev.prefersReducedMotion === next.prefersReducedMotion &&
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
  forwardRef<
    MemoizedMessageListHandle,
    {
      messages: any[];
      leadingUserMessage?: any;
      threadEvents?: ThreadEvent[];
      compactionEvents?: CompactionEvent[];
      threadId: string;
      threadStatus?: string;
      knownIds: Set<string>;
      prefersReducedMotion: boolean | null;
      snapshotMap: Map<string, number>;
      onSend: (prompt: string, opts: { model: string; mode: string }) => void;
      onOpenLightbox: (images: { src: string; alt: string }[], index: number) => void;
      onToolRespond?: (toolCallId: string, answer: string, toolName: string) => void;
      onFork?: (messageId: string) => void;
      onRewind?: (messageId: string) => void;
      onForkAndRewind?: (messageId: string) => void;
      forkingMessageId?: string | null;
      rewindDisabled?: boolean;
      rewindDisabledReason?: string;
      scrollRef: React.RefObject<HTMLElement | null>;
      /** Per-session changed files, keyed by the session's user-message id.
       *  Each entry renders a changed-files summary at the end of that session. */
      sessionChanges?: Map<string, FileDiffSummary[]>;
      /** Whether the agent is running (disables the latest session's revert). */
      changeSummaryRunning?: boolean;
      /** Called after a revert so the diff data refetches. */
      onSessionReverted?: () => void;
    }
  >(function MemoizedMessageList(
    {
      messages,
      leadingUserMessage,
      threadEvents,
      compactionEvents,
      threadId,
      threadStatus,
      knownIds: _knownIds,
      prefersReducedMotion,
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
    },
    ref,
  ) {
    const { t } = useTranslation();
    // Re-render every 60s so timeAgo timestamps in tool cards stay fresh.
    // Needed here (not just in ThreadView) because the custom memo comparator
    // blocks parent-driven re-renders when only the tick changes.
    useMinuteTick();

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
    const leadingUserItem = useMemo<MessageItem | null>(() => {
      if (!leadingUserMessage) return null;
      if (messages.some((msg) => msg.id === leadingUserMessage.id)) return null;
      return { type: 'message', msg: leadingUserMessage };
    }, [leadingUserMessage, messages]);

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
    const [listScrollMargin, setListScrollMargin] = useState(0);
    const [measuredLeadingStickyHeight, setMeasuredLeadingStickyHeight] = useState(0);

    const measureListScrollMargin = useCallback(() => {
      const viewport = scrollRef.current;
      const container = itemContainerRef.current;
      if (!viewport || !container) return 0;

      const viewportRect = viewport.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      return Math.max(0, Math.round(containerRect.top - viewportRect.top + viewport.scrollTop));
    }, [scrollRef]);

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
    }, [scrollRef]);

    // ── Container width for pretext estimation ───────────────────────
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
    }, []);

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

    // ── Pretext warm-up: prepare assistant message texts in background ──
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

    const virtualRows = useMemo<VirtualRow[]>(() => {
      const rows: VirtualRow[] = [];
      let currentUser: MessageItem | null = null;
      let currentSessionItems: RenderItem[] = [];

      const appendSessionSummary = () => {
        if (!currentUser) return;
        const files = sessionChanges?.get(currentUser.msg.id);
        if (!files || files.length === 0) return;
        rows.push({
          type: 'session-summary',
          key: `session-summary-${currentUser.msg.id}`,
          userItem: currentUser,
          files,
          fallbackDiffs: buildToolCallDiffFallbacks(currentSessionItems, files),
          isLastSection: false,
        });
      };

      groupedItems.forEach((item, itemIndex) => {
        if (item.type === 'message' && item.msg.role === 'user') {
          appendSessionSummary();
          currentUser = item as MessageItem;
          currentSessionItems = [];
        } else if (currentUser) {
          currentSessionItems.push(item);
        }
        rows.push({
          type: 'item',
          key: getItemKey(item),
          item,
          itemIndex,
        });
      });
      appendSessionSummary();

      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        if (row.type === 'session-summary') {
          rows[i] = { ...row, isLastSection: true };
          break;
        }
      }

      return rows;
    }, [groupedItems, sessionChanges]);
    const virtualRowsSignature = useMemo(
      () => virtualRows.map((row) => row.key).join('\n'),
      [virtualRows],
    );
    const shouldReserveLeadingStickySpace = Boolean(
      leadingUserItem &&
      virtualRows[0]?.type === 'item' &&
      virtualRows[0].item.type === 'message' &&
      virtualRows[0].item.msg.role !== 'user',
    );
    const estimatedLeadingStickySpacerHeight = useMemo(() => {
      if (!leadingUserItem) return 0;
      return estimateItemHeight(leadingUserItem, containerWidth, fontConfig) + VIRTUAL_ROW_GAP_PX;
    }, [containerWidth, fontConfig, leadingUserItem]);
    const leadingStickySpacerHeight = shouldReserveLeadingStickySpace
      ? Math.max(measuredLeadingStickyHeight, estimatedLeadingStickySpacerHeight)
      : 0;

    const rowKeyIndexMap = useMemo(() => {
      const map = new Map<string, number>();
      virtualRows.forEach((row, index) => map.set(row.key, index));
      return map;
    }, [virtualRows]);

    const userRowVirtualIndices = useMemo(() => {
      const indices: number[] = [];
      virtualRows.forEach((row, index) => {
        if (row.type === 'item' && row.item.type === 'message' && row.item.msg.role === 'user') {
          indices.push(index);
        }
      });
      return indices;
    }, [virtualRows]);

    const itemIndexMap = useMemo(() => {
      const groupedIdIndexMap = buildRenderItemIdIndexMap(groupedItems);
      const groupedToVirtualIndex = new Map<number, number>();
      virtualRows.forEach((row, virtualIndex) => {
        if (row.type === 'item') groupedToVirtualIndex.set(row.itemIndex, virtualIndex);
      });

      const map = new Map<string, number>();
      groupedIdIndexMap.forEach((groupedIndex, id) => {
        const virtualIndex = groupedToVirtualIndex.get(groupedIndex);
        if (virtualIndex !== undefined) map.set(id, virtualIndex);
      });
      return map;
    }, [groupedItems, virtualRows]);

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
    const fallbackVirtualItems = useMemo(() => {
      if (!shouldUseVirtualFallback) return [];
      let offset = 0;
      return virtualRows.map((row, index) => {
        const size =
          heightCache.get(row.key) ?? estimateVirtualRowHeight(row, containerWidth, fontConfig);
        const item = {
          key: row.key,
          index,
          start: offset,
          size,
          end: offset + size,
          lane: 0,
        };
        offset = item.end + VIRTUAL_ROW_GAP_PX;
        return item;
      });
    }, [containerWidth, fontConfig, heightCache, shouldUseVirtualFallback, virtualRows]);
    const visibleVirtualItems = shouldUseVirtualFallback ? fallbackVirtualItems : virtualItems;
    const fallbackContentHeight = fallbackVirtualItems.at(-1)?.end ?? 0;
    const lastRow = virtualRows.at(-1);
    const lastVirtualItem = visibleVirtualItems.find(
      (virtualItem) => virtualItem.index === virtualRows.length - 1,
    );
    const measuredLastRowHeight = lastRow ? heightCache.get(lastRow.key) : undefined;
    const measuredLastRowBottom =
      lastVirtualItem && measuredLastRowHeight !== undefined
        ? lastVirtualItem.start -
          listScrollMargin +
          leadingStickySpacerHeight +
          measuredLastRowHeight
        : undefined;
    const virtualContentHeight =
      measuredLastRowBottom !== undefined
        ? Math.max(0, measuredLastRowBottom)
        : Math.max(
            rowVirtualizer.getTotalSize() + leadingStickySpacerHeight,
            measuredContentBottom,
            fallbackContentHeight + leadingStickySpacerHeight,
          );

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
      if (!shouldReserveLeadingStickySpace) {
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
    }, [shouldReserveLeadingStickySpace, hiddenSectionUserItem?.msg.id]);

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

    const renderToolItem = useCallback(
      (ti: ToolItem) => {
        if (ti.type === 'toolcall') {
          const tc = ti.tc;
          return (
            <div
              key={tc.id}
              data-tool-call-id={tc.id}
              {...(snapshotMap.has(tc.id) ? { 'data-todo-snapshot': snapshotMap.get(tc.id) } : {})}
            >
              <ToolCallCard
                name={tc.name}
                input={tc.input}
                output={tc.output}
                author={tc.author}
                timestamp={tc.timestamp}
                planText={tc._planText}
                childToolCalls={tc._childToolCalls}
                onRespond={
                  (tc.name === 'AskUserQuestion' || tc.name === 'ExitPlanMode') &&
                  isWaiting &&
                  onToolRespond
                    ? (answer: string) => {
                        onToolRespond(tc.id, answer, tc.name);
                        onSend(answer, { model: '', mode: '' });
                      }
                    : undefined
                }
              />
            </div>
          );
        }
        if (ti.type === 'toolcall-group') {
          const groupSnapshotIdx =
            ti.name === 'TodoWrite'
              ? Math.max(...ti.calls.map((c: any) => snapshotMap.get(c.id) ?? -1))
              : -1;
          return (
            <div
              key={ti.calls[0].id}
              data-tool-call-id={ti.calls[0].id}
              {...(groupSnapshotIdx >= 0 ? { 'data-todo-snapshot': groupSnapshotIdx } : {})}
            >
              <ToolCallGroup
                name={ti.name}
                calls={ti.calls}
                timestamp={ti.calls[0]?.timestamp}
                renderCall={(call) => (
                  <ToolCallCard
                    key={call.id}
                    name={ti.name}
                    input={call.input}
                    output={call.output}
                    author={call.author}
                    childToolCalls={call._childToolCalls}
                    hideLabel
                    onRespond={
                      (ti.name === 'AskUserQuestion' || ti.name === 'ExitPlanMode') &&
                      isWaiting &&
                      onToolRespond &&
                      !call.output
                        ? (answer: string) => {
                            onToolRespond(call.id, answer, ti.name);
                            onSend(answer, { model: '', mode: '' });
                          }
                        : undefined
                    }
                  />
                )}
              />
            </div>
          );
        }
        return null;
      },
      [snapshotMap, isWaiting, onSend, onToolRespond],
    );

    const renderNonUserItem = useCallback(
      (item: RenderItem) => {
        const key = getItemKey(item);

        if (item.type === 'message') {
          const msg = item.msg;
          // `contentVisibility:auto` was previously applied here for paint
          // virtualization. It broke a specific pattern: the server inserts
          // an empty assistant placeholder (content=''), Chrome remembers
          // the small rendered size, then the WS event updates the message
          // content (same msgId, content='…') — React re-renders the
          // subtree but the slot's c-v:auto skips the repaint, leaving the
          // user with a visible "task complete" indicator but no response
          // text until a forced paint (tab switch, scroll, focus). Removed for
          // messages and variable-height tool rows.
          return (
            <div
              key={key}
              data-item-key={key}
              className="group/msg text-foreground relative w-full text-sm"
            >
              <div className="text-sm leading-relaxed wrap-break-word">
                <div className="flex items-start gap-2">
                  {msg.author && <AuthorAvatar author={msg.author} />}
                  <div className="min-w-0 flex-1">
                    <MessageContent content={msg.content.trim()} />
                  </div>
                  <CopyButton content={msg.content} />
                </div>
                <div className="mt-1">
                  <span className="text-muted-foreground/80 text-xs select-none">
                    {timeAgo(msg.timestamp, t)}
                  </span>
                </div>
              </div>
            </div>
          );
        }

        if (item.type === 'toolcall' || item.type === 'toolcall-group') {
          return (
            <div key={key} data-item-key={key}>
              {renderToolItem(item)}
            </div>
          );
        }

        if (item.type === 'toolcall-run') {
          return (
            <div key={key} data-item-key={key}>
              <div className="space-y-1">{item.items.map(renderToolItem)}</div>
            </div>
          );
        }

        if (item.type === 'workflow-event-group') {
          return (
            <div key={key} data-item-key={key}>
              <WorkflowEventGroup events={item.events} />
            </div>
          );
        }

        if (item.type === 'thread-event') {
          return (
            <div key={key} data-item-key={key}>
              <GitEventCard event={item.event} />
            </div>
          );
        }

        if (item.type === 'compaction-event') {
          return (
            <div key={key} data-item-key={key}>
              <CompactionEventCard event={item.event} />
            </div>
          );
        }

        return null;
      },
      [renderToolItem, t],
    );

    const renderUserMessage = useCallback(
      (
        item: Extract<RenderItem, { type: 'message' }>,
        { includeItemKey = true, includeUserObserver = true }: RenderUserMessageOptions = {},
      ) => {
        const msg = item.msg;
        return (
          <div
            className="relative pt-3 pb-3"
            {...(includeUserObserver ? { 'data-user-msg': msg.id } : {})}
            {...(includeItemKey ? { 'data-item-key': msg.id } : {})}
          >
            <UserMessageCard
              data-testid={`user-message-${msg.id}`}
              content={msg.content}
              images={msg.images}
              model={msg.model}
              permissionMode={msg.permissionMode}
              effort={msg.effort}
              timestamp={msg.timestamp}
              onClick={() => scrollToUserMessagePosition(msg.id)}
              onImageClick={onOpenLightbox}
              onFork={onFork ? () => onFork(msg.id) : undefined}
              onRewind={onRewind ? () => onRewind(msg.id) : undefined}
              onForkAndRewind={onForkAndRewind ? () => onForkAndRewind(msg.id) : undefined}
              forkDisabled={forkingMessageId != null}
              rewindDisabled={rewindDisabled}
              rewindDisabledReason={rewindDisabledReason}
            />
          </div>
        );
      },
      [
        onOpenLightbox,
        onFork,
        onRewind,
        onForkAndRewind,
        forkingMessageId,
        rewindDisabled,
        rewindDisabledReason,
        scrollToUserMessagePosition,
      ],
    );

    const renderVirtualRowContent = useCallback(
      (row: VirtualRow) => {
        if (row.type === 'session-summary') {
          return (
            <div className="mt-3">
              <ChangedFilesSummary
                threadId={threadId}
                files={row.files}
                running={row.isLastSection && !!changeSummaryRunning}
                onReverted={onSessionReverted}
                fallbackDiffs={row.fallbackDiffs}
              />
            </div>
          );
        }

        const item = row.item;
        if (item.type === 'message' && item.msg.role === 'user') {
          return renderUserMessage(item as MessageItem);
        }

        return <>{renderNonUserItem(item)}</>;
      },
      [changeSummaryRunning, onSessionReverted, renderNonUserItem, renderUserMessage, threadId],
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
            className={cn(
              'pointer-events-none sticky top-0 z-50 h-0',
              !prefersReducedMotion && 'animate-in fade-in',
            )}
          >
            <div
              ref={stickySectionContentRef}
              data-testid="sticky-section-content"
              className="pointer-events-auto relative z-50 pt-3 pb-3"
              style={stickyPushPx < 0 ? { transform: `translateY(${stickyPushPx}px)` } : undefined}
            >
              {renderUserMessage(hiddenSectionUserItem, {
                includeItemKey: false,
                includeUserObserver: false,
              })}
            </div>
          </div>
        ) : null}
        {visibleVirtualItems.map((virtualItem) => {
          const row = virtualRows[virtualItem.index];
          if (!row) return null;

          return (
            <div
              key={virtualItem.key}
              ref={measureVirtualRowElement}
              data-index={virtualItem.index}
              data-virtual-row-key={row.key}
              {...(row.type === 'item' &&
              row.item.type === 'message' &&
              row.item.msg.role === 'user'
                ? { 'data-section-msg-id': row.item.msg.id }
                : {})}
              className="absolute top-0 left-0 z-0 w-full"
              style={{
                transform: `translateY(${
                  virtualItem.start - listScrollMargin + leadingStickySpacerHeight
                }px)`,
                overflowAnchor: 'none',
              }}
            >
              {renderVirtualRowContent(row)}
            </div>
          );
        })}
      </div>
    );
  }),
  messageListAreEqual,
);
