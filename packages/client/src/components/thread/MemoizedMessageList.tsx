import type { FileDiffSummary, ThreadEvent } from '@funny/shared';
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual';
import {
  useState,
  useRef,
  useEffect,
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
import {
  buildRenderItemIdIndexMap,
  buildGroupedRenderItems,
  findNearestPrecedingUserMessageItem,
  getItemKey,
  type ToolItem,
  type RenderItem,
  type UserMessageRenderItem,
} from '@/lib/render-items';
import { timeAgo } from '@/lib/thread-utils';
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

/* ── Virtualized rendering constants ──────────────────────────────── */
const VIRTUAL_OVERSCAN = 8;
const VIRTUAL_ROW_GAP_PX = 8;
const STICKY_HANDOFF_PX = 72;
const ASSISTANT_TEXT_WIDTH_RESERVE_PX = 128;
const ASSISTANT_CHROME_PX = 40;
const ASSISTANT_ESTIMATE_BUFFER_PX = 12;
const TOOL_HEADER_PX = 34;
const TOOL_RUN_GAP_PX = 4;
const TOOL_SCROLL_BODY_MAX_PX = 420;

export const EMPTY_MESSAGES: any[] = [];

interface FontConfig {
  proseFont: string;
  proseLineHeight: number;
  codeLineHeight: number;
}

function coerceToolInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return { input };
    }
  }
  return {};
}

function textLineCount(value: unknown): number {
  if (value == null) return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (!text) return 0;
  return text.split('\n').length;
}

function estimateWrappedLineCount(
  value: unknown,
  containerWidth: number,
  avgCharWidth = 7,
): number {
  if (value == null) return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (!text) return 0;
  const usableWidth = containerWidth > 0 ? Math.max(180, containerWidth - 96) : 520;
  const charsPerLine = Math.max(24, Math.floor(usableWidth / avgCharWidth));
  return text.split('\n').reduce((sum, line) => {
    return sum + Math.max(1, Math.ceil(line.length / charsPerLine));
  }, 0);
}

function estimateFallbackProseHeight(
  content: string,
  containerWidth: number,
  fonts?: FontConfig,
): number {
  const lineHeight = fonts?.proseLineHeight ?? PROSE_LINE_HEIGHT_PX.default;
  const usableWidth = containerWidth > 0 ? Math.max(180, containerWidth - 128) : 520;
  const charsPerLine = Math.max(28, Math.floor(usableWidth / 7));
  return content.split('\n').reduce((sum, line) => {
    const len = line.trim().length;
    return sum + (len === 0 ? lineHeight : Math.ceil(len / charsPerLine) * lineHeight);
  }, 0);
}

function estimateMarkdownExtraHeight(
  analysis: ReturnType<typeof analyzeMarkdown>,
  fonts?: FontConfig,
): number {
  const codeLineHeight = fonts?.codeLineHeight ?? CODE_LINE_HEIGHT_PX.default;
  const codeHeight = analysis.codeBlockLines * codeLineHeight + analysis.codeBlockCount * 30;
  const proseSpacing = Math.max(0, analysis.paragraphCount - 1) * 8;
  const listSpacing = analysis.listItemCount * 2;
  const tableHeight = analysis.tableRowCount * 8;
  const inlineCodePadding = analysis.inlineCodeCount > 0 ? 4 : 0;
  return (
    analysis.extraHeightPx +
    codeHeight +
    proseSpacing +
    listSpacing +
    tableHeight +
    inlineCodePadding
  );
}

function estimateAssistantMessageHeight(
  content: string,
  containerWidth: number,
  fonts?: FontConfig,
): number {
  const analysis = analyzeMarkdown(content);
  const prepared =
    containerWidth > 100 && isPretextReady() && fonts
      ? getCachedPrepared(analysis.plainText, fonts.proseFont)
      : undefined;
  const textWidth = Math.max(120, containerWidth - ASSISTANT_TEXT_WIDTH_RESERVE_PX);
  const proseHeight =
    prepared && fonts
      ? layoutSync(prepared, textWidth, fonts.proseLineHeight).height
      : estimateFallbackProseHeight(analysis.plainText || content, containerWidth, fonts);
  const totalHeight =
    proseHeight +
    estimateMarkdownExtraHeight(analysis, fonts) +
    ASSISTANT_CHROME_PX +
    ASSISTANT_ESTIMATE_BUFFER_PX;
  return Math.max(Math.ceil(totalHeight), 72);
}

function estimateToolCardHeight(tc: any, containerWidth: number, fonts?: FontConfig): number {
  const parsed = coerceToolInput(tc?.input);
  const name = tc?.name;
  const codeLineHeight = fonts?.codeLineHeight ?? CODE_LINE_HEIGHT_PX.default;

  if (name === 'Write') {
    const content = parsed.content;
    const contentLines = estimateWrappedLineCount(content, containerWidth, 7);
    const body = Math.min(TOOL_SCROLL_BODY_MAX_PX, contentLines * codeLineHeight + 54);
    return TOOL_HEADER_PX + body;
  }

  if (name === 'Edit') {
    const oldLines = textLineCount(parsed.old_string);
    const newLines = textLineCount(parsed.new_string);
    const changedLines = Math.max(oldLines, newLines);
    const body = Math.min(TOOL_SCROLL_BODY_MAX_PX, Math.max(3, changedLines + 4) * codeLineHeight);
    return TOOL_HEADER_PX + body;
  }

  if (name === 'Read') {
    return TOOL_HEADER_PX;
  }

  if (name === 'Bash') {
    return TOOL_HEADER_PX;
  }

  if (name === 'Task' || name === 'Agent') {
    const promptLines = estimateWrappedLineCount(
      parsed.prompt ?? parsed.description,
      containerWidth,
    );
    const childCount = Array.isArray(tc?._childToolCalls) ? tc._childToolCalls.length : 0;
    return TOOL_HEADER_PX + Math.min(240, promptLines * 18 + childCount * 28 + 28);
  }

  if (name === 'AskUserQuestion' || name === 'ExitPlanMode') {
    return 120;
  }

  if (name === 'Think') {
    const text = typeof parsed.thought === 'string' ? parsed.thought : tc?.output;
    return TOOL_HEADER_PX + Math.min(220, estimateWrappedLineCount(text, containerWidth) * 18 + 24);
  }

  const inputLines = Object.values(parsed).reduce<number>(
    (sum, value) => sum + estimateWrappedLineCount(value, containerWidth),
    0,
  );
  const outputLines = estimateWrappedLineCount(tc?.output, containerWidth);
  const hasExpandedBody = inputLines > 0 || outputLines > 0;
  return (
    TOOL_HEADER_PX + (hasExpandedBody ? Math.min(220, (inputLines + outputLines) * 18 + 36) : 0)
  );
}

function estimateToolItemHeight(
  item: ToolItem,
  containerWidth: number,
  fonts?: FontConfig,
): number {
  if (item.type === 'toolcall') return estimateToolCardHeight(item.tc, containerWidth, fonts);
  return TOOL_HEADER_PX;
}

/**
 * Estimate item height. For assistant messages, uses pretext measurements when
 * available for much more accurate estimates than the flat 120px fallback.
 * containerWidth = 0 means "use flat fallback" (pretext not ready or width unknown).
 */
function estimateItemHeight(item: RenderItem, containerWidth = 0, fonts?: FontConfig): number {
  if (item.type === 'message') {
    if (item.msg.role === 'user') return 80;

    const content = item.msg.content?.trim();
    return content ? estimateAssistantMessageHeight(content, containerWidth, fonts) : 72;
  }
  if (item.type === 'toolcall' || item.type === 'toolcall-group') {
    return estimateToolItemHeight(item, containerWidth, fonts);
  }
  if (item.type === 'toolcall-run') {
    return (
      item.items.reduce((sum, toolItem) => {
        return sum + estimateToolItemHeight(toolItem, containerWidth, fonts);
      }, 0) +
      Math.max(0, item.items.length - 1) * TOOL_RUN_GAP_PX
    );
  }
  if (item.type === 'thread-event') return 32;
  if (item.type === 'compaction-event') return 32;
  if (item.type === 'workflow-event-group') return 32;
  return 60;
}

export interface MemoizedMessageListHandle {
  scrollToBottom: () => void;
  expandToItem: (id: string) => void;
  hasHiddenItems: () => boolean;
  captureScrollAnchor: () => void;
  restoreScrollAnchor: () => void;
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

/** Memoized message list with true DOM virtualization over grouped render items. */
export const MemoizedMessageList = memo(
  forwardRef<
    MemoizedMessageListHandle,
    {
      messages: any[];
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
      threadEvents,
      compactionEvents,
      threadId,
      threadStatus,
      knownIds: _knownIds,
      prefersReducedMotion: _prefersReducedMotion,
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

    // Use a ref for threadStatus so renderToolItem's identity stays stable
    // across non-waiting status changes (running→running, etc.)
    const threadStatusRef = useRef(threadStatus);
    threadStatusRef.current = threadStatus;
    const isWaiting = threadStatus === 'waiting';

    const groupedItems = useMemo(
      () => buildGroupedRenderItems(messages, threadEvents, compactionEvents),
      [messages, threadEvents, compactionEvents],
    );
    const [pretextRevision, setPretextRevision] = useState(0);

    /* ── Virtualized rendering ─────────────────────────────────────── */
    const itemContainerRef = useRef<HTMLDivElement>(null);

    // ── Container width for pretext estimation ───────────────────────
    const [containerWidth, setContainerWidth] = useState(0);
    useEffect(() => {
      const el = itemContainerRef.current;
      if (!el) return;
      const ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          setContainerWidth(entry.contentRect.width);
        }
      });
      ro.observe(el);
      setContainerWidth(el.clientWidth);
      return () => ro.disconnect();
    }, []);

    const [scrollMargin, setScrollMargin] = useState(0);
    const updateScrollMargin = useCallback(() => {
      const viewport = scrollRef.current;
      const container = itemContainerRef.current;
      if (!viewport || !container) return;

      const vpRect = viewport.getBoundingClientRect();
      const cRect = container.getBoundingClientRect();
      const next = cRect.top - vpRect.top + viewport.scrollTop;
      setScrollMargin((prev) => (Math.abs(prev - next) > 1 ? next : prev));
    }, [scrollRef]);

    useLayoutEffect(() => {
      updateScrollMargin();
    });

    useLayoutEffect(() => {
      const viewport = scrollRef.current;
      const container = itemContainerRef.current;
      if (!viewport || !container) return;

      updateScrollMargin();
      const ro = new ResizeObserver(updateScrollMargin);
      ro.observe(viewport);
      ro.observe(container);
      if (container.parentElement) ro.observe(container.parentElement);

      viewport.addEventListener('scroll', updateScrollMargin, {
        passive: true,
      });
      window.addEventListener('resize', updateScrollMargin);
      return () => {
        ro.disconnect();
        viewport.removeEventListener('scroll', updateScrollMargin);
        window.removeEventListener('resize', updateScrollMargin);
      };
    }, [scrollRef, threadId, updateScrollMargin]);

    const rowVirtualizer = useVirtualizer({
      count: groupedItems.length,
      getScrollElement: () => scrollRef.current,
      estimateSize: (index) => {
        const item = groupedItems[index];
        return (
          (item ? estimateItemHeight(item, containerWidth, fontConfig) : 60) + VIRTUAL_ROW_GAP_PX
        );
      },
      getItemKey: (index) => {
        const item = groupedItems[index];
        return item ? getItemKey(item) : index;
      },
      overscan: VIRTUAL_OVERSCAN,
      scrollMargin,
    });

    useEffect(() => {
      rowVirtualizer.measure();
    }, [rowVirtualizer, groupedItems, containerWidth, fontConfig, pretextRevision]);

    const virtualItems = rowVirtualizer.getVirtualItems();
    const firstVirtualIndex = virtualItems[0]?.index ?? 0;
    const scrollOffset = rowVirtualizer.scrollOffset ?? 0;

    const firstViewportVirtualItem = useMemo(() => {
      return (
        virtualItems.find((item) => (item.end ?? item.start + item.size) > scrollOffset) ??
        virtualItems[0] ??
        null
      );
    }, [scrollOffset, virtualItems]);

    const itemIndexMap = useMemo(() => buildRenderItemIdIndexMap(groupedItems), [groupedItems]);

    const itemKeyIndexMap = useMemo(() => {
      const map = new Map<string, number>();
      groupedItems.forEach((item, index) => map.set(getItemKey(item), index));
      return map;
    }, [groupedItems]);

    const sectionUserByIndex = useMemo(() => {
      const owners: (UserMessageRenderItem | null)[] = [];
      let current: UserMessageRenderItem | null = null;
      groupedItems.forEach((item, index) => {
        if (item.type === 'message' && item.msg.role === 'user') current = item;
        owners[index] = current;
      });
      return owners;
    }, [groupedItems]);

    const sectionLastIndexByUserId = useMemo(() => {
      const map = new Map<string, number>();
      sectionUserByIndex.forEach((userItem, index) => {
        if (userItem) map.set(userItem.msg.id, index);
      });
      return map;
    }, [sectionUserByIndex]);

    const stickySectionState = useMemo(() => {
      const firstViewportIndex = firstViewportVirtualItem?.index ?? 0;
      if (!firstViewportVirtualItem || firstViewportIndex <= 0) return null;

      const firstVisible = groupedItems[firstViewportIndex];
      if (!firstVisible) return null;

      if (firstVisible.type === 'message' && firstVisible.msg.role === 'user') {
        const rawProgress =
          (scrollOffset - firstViewportVirtualItem.start) /
          Math.min(STICKY_HANDOFF_PX, firstViewportVirtualItem.size || STICKY_HANDOFF_PX);
        const progress = Math.min(1, Math.max(0, rawProgress));
        const previousUser = findNearestPrecedingUserMessageItem(groupedItems, firstViewportIndex);

        if (previousUser && progress < 1) {
          return {
            userItem: previousUser,
            opacity: 1 - progress,
            translateY: -12 * progress,
          };
        }

        return {
          userItem: firstVisible,
          opacity: progress,
          translateY: 8 * (1 - progress),
        };
      }

      const userItem =
        sectionUserByIndex[firstViewportIndex] ??
        findNearestPrecedingUserMessageItem(groupedItems, firstViewportIndex);

      return userItem
        ? {
            userItem,
            opacity: 1,
            translateY: 0,
          }
        : null;
    }, [firstViewportVirtualItem, groupedItems, scrollOffset, sectionUserByIndex]);

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
            if (item.type === 'message' && item.msg.role === 'assistant' && item.msg.content) {
              const analysis = analyzeMarkdown(item.msg.content.trim());
              if (analysis.plainText && !getCachedPrepared(analysis.plainText, proseFont)) {
                toPrepare.push(analysis.plainText);
              }
            }
          }

          if (toPrepare.length > 0) {
            Promise.resolve(
              prepareBatch(toPrepare, proseFont, {
                signal: cancelled ? AbortSignal.abort() : undefined,
              }),
            ).then((prepared) => {
              if (!cancelled && prepared > 0) setPretextRevision((revision) => revision + 1);
            });
          } else {
            setPretextRevision((revision) => revision + 1);
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

    // ── Scroll anchor: capture/restore for jank-free scroll preservation ──
    const scrollAnchorRef = useRef<{
      key: string;
      offsetFromViewportTop: number;
    } | null>(null);

    const captureScrollAnchor = useCallback(() => {
      const viewport = scrollRef.current;
      const container = itemContainerRef.current;
      if (!viewport || !container) return;

      const vpRect = viewport.getBoundingClientRect();
      const items = container.querySelectorAll<HTMLElement>('[data-item-key]');
      for (const item of items) {
        const rect = item.getBoundingClientRect();
        if (rect.bottom > vpRect.top) {
          scrollAnchorRef.current = {
            key: item.dataset.itemKey!,
            offsetFromViewportTop: rect.top - vpRect.top,
          };
          return;
        }
      }
    }, [scrollRef]);

    const restoreScrollAnchor = useCallback(() => {
      const viewport = scrollRef.current;
      const container = itemContainerRef.current;
      const anchor = scrollAnchorRef.current;
      if (!viewport || !container || !anchor) return;

      const applyDrift = (el: HTMLElement) => {
        const vpRect = viewport.getBoundingClientRect();
        const rect = el.getBoundingClientRect();
        const currentOffset = rect.top - vpRect.top;
        const drift = currentOffset - anchor.offsetFromViewportTop;
        viewport.scrollTop += drift;
      };

      const el = container.querySelector<HTMLElement>(
        `[data-item-key="${CSS.escape(anchor.key)}"]`,
      );
      if (el) {
        applyDrift(el);
        scrollAnchorRef.current = null;
        return;
      }

      const index = itemKeyIndexMap.get(anchor.key);
      if (index === undefined) {
        scrollAnchorRef.current = null;
        return;
      }

      rowVirtualizer.scrollToIndex(index, { align: 'start' });
      requestAnimationFrame(() => {
        const nextEl = container.querySelector<HTMLElement>(
          `[data-item-key="${CSS.escape(anchor.key)}"]`,
        );
        if (nextEl) applyDrift(nextEl);
        scrollAnchorRef.current = null;
      });
    }, [scrollRef, itemKeyIndexMap, rowVirtualizer]);

    // Expose helpers so parent can interact with the virtualized list.
    useImperativeHandle(
      ref,
      () => ({
        scrollToBottom: () => {
          const index = groupedItems.length - 1;
          if (index < 0) return;
          rowVirtualizer.scrollToIndex(index, { align: 'end' });
          requestAnimationFrame(() => {
            rowVirtualizer.scrollToIndex(index, { align: 'end' });
          });
        },
        expandToItem: (id: string) => {
          const index = itemIndexMap.get(id);
          if (index === undefined) return;
          rowVirtualizer.scrollToIndex(index, { align: 'center' });
          requestAnimationFrame(() => {
            rowVirtualizer.scrollToIndex(index, { align: 'center' });
          });
        },
        hasHiddenItems: () => {
          const first = rowVirtualizer.getVirtualItems()[0];
          return first ? first.index > 0 : false;
        },
        captureScrollAnchor,
        restoreScrollAnchor,
      }),
      [groupedItems.length, itemIndexMap, rowVirtualizer, captureScrollAnchor, restoreScrollAnchor],
    );

    // When virtualization reaches the top loaded row, re-dispatch a scroll
    // event so MessageStream's top-pagination gate can run after the range
    // update, even if the user is already parked at scrollTop≈0.
    const prevVirtualRangeRef = useRef({ threadId, firstVirtualIndex });
    useEffect(() => {
      const prev = prevVirtualRangeRef.current;
      prevVirtualRangeRef.current = { threadId, firstVirtualIndex };
      if (prev.threadId !== threadId) return;
      if (prev.firstVirtualIndex <= 0 || firstVirtualIndex !== 0) return;

      const scrollEl = scrollRef.current;
      if (!scrollEl) return;
      const rafId = requestAnimationFrame(() => {
        scrollEl.dispatchEvent(new Event('scroll'));
      });
      return () => cancelAnimationFrame(rafId);
    }, [threadId, firstVirtualIndex, scrollRef]);

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
          // Do not add CSS paint virtualization inside virtual rows. The
          // virtualizer needs the real DOM height; content-visibility can make
          // Chrome report an intrinsic fallback and cause row overlap.
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
        opts: { includeItemKey?: boolean; sticky?: boolean } = {},
      ) => {
        const msg = item.msg;
        const includeItemKey = opts.includeItemKey ?? true;
        const sticky = opts.sticky ?? false;
        return (
          <div
            className={sticky ? 'sticky top-0 z-20 pt-3 pb-3' : 'relative pt-3 pb-3'}
            data-user-msg={msg.id}
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
              onClick={() => {
                const viewport = scrollRef.current;
                const section = viewport?.querySelector(`[data-section-msg-id="${msg.id}"]`);
                if (!viewport || !section) return;

                const viewportRect = viewport.getBoundingClientRect();
                const sectionRect = section.getBoundingClientRect();
                // Bring the section's top to the top of the viewport…
                const desiredTop = viewport.scrollTop + (sectionRect.top - viewportRect.top);

                // …but never scroll past the point where the real message
                // content (everything except the sticky bottom prompt dock)
                // still reaches the viewport bottom. Otherwise a short final
                // section gets yanked all the way up, exposing the empty area
                // above the pinned prompt input.
                const content = itemContainerRef.current?.parentElement;
                const maxUsefulTop = content
                  ? viewport.scrollTop +
                    (content.getBoundingClientRect().bottom - viewportRect.bottom)
                  : desiredTop;

                viewport.scrollTo({
                  top: Math.max(0, Math.min(desiredTop, maxUsefulTop)),
                  behavior: 'smooth',
                });
              }}
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
        scrollRef,
        onFork,
        onRewind,
        onForkAndRewind,
        forkingMessageId,
        rewindDisabled,
        rewindDisabledReason,
      ],
    );

    const renderSessionSummary = useCallback(
      (userItem: UserMessageRenderItem, isLastSection: boolean) => {
        const sessionFiles = sessionChanges?.get(userItem.msg.id);
        if (!sessionFiles || sessionFiles.length === 0) return null;

        return (
          <div className="mt-3">
            <ChangedFilesSummary
              threadId={threadId}
              files={sessionFiles}
              running={isLastSection && !!changeSummaryRunning}
              onReverted={onSessionReverted}
            />
          </div>
        );
      },
      [changeSummaryRunning, onSessionReverted, sessionChanges, threadId],
    );

    const renderVirtualItem = useCallback(
      (virtualRow: VirtualItem) => {
        const item = groupedItems[virtualRow.index];
        if (!item) return null;

        const sectionUser = sectionUserByIndex[virtualRow.index];
        const sectionUserId = sectionUser?.msg.id;
        const isLastSection = virtualRow.index === groupedItems.length - 1;
        const isLastItemInSection =
          !!sectionUserId && sectionLastIndexByUserId.get(sectionUserId) === virtualRow.index;

        return (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={rowVirtualizer.measureElement}
            className="absolute top-0 left-0 w-full pb-2"
            style={{
              transform: `translateY(${virtualRow.start - rowVirtualizer.options.scrollMargin}px)`,
            }}
          >
            {item.type === 'message' && item.msg.role === 'user' ? (
              <div data-section-msg-id={item.msg.id}>
                {renderUserMessage(item, { sticky: false })}
              </div>
            ) : (
              renderNonUserItem(item)
            )}
            {sectionUser && isLastItemInSection && renderSessionSummary(sectionUser, isLastSection)}
          </div>
        );
      },
      [
        groupedItems,
        renderNonUserItem,
        renderSessionSummary,
        renderUserMessage,
        rowVirtualizer,
        sectionLastIndexByUserId,
        sectionUserByIndex,
      ],
    );

    return (
      <div ref={itemContainerRef}>
        {stickySectionState && (
          <div
            className="sticky top-0 z-30 h-0 transition-[opacity,transform] duration-150 ease-out"
            data-sticky-section-context={stickySectionState.userItem.msg.id}
            style={{
              opacity: stickySectionState.opacity,
              transform: `translateY(${stickySectionState.translateY}px)`,
              pointerEvents: stickySectionState.opacity < 0.2 ? 'none' : undefined,
            }}
          >
            {renderUserMessage(stickySectionState.userItem, {
              includeItemKey: false,
              sticky: false,
            })}
          </div>
        )}
        <div
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualItems.map(renderVirtualItem)}
        </div>
      </div>
    );
  }),
  messageListAreEqual,
);
