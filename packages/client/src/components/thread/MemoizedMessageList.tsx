import type { ThreadEvent } from '@funny/shared';
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
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
  buildGroupedRenderItems,
  getItemKey,
  type ToolItem,
  type RenderItem,
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
import { CompactionEventCard } from './CompactionEventCard';
import { GitEventCard } from './GitEventCard';
import { MessageContent, CopyButton } from './MessageContent';
import { UserMessageCard } from './UserMessageCard';
import { WorkflowEventGroup } from './WorkflowEventGroup';

/* ── Windowed rendering constants ─────────────────────────────────── */
const INITIAL_WINDOW = 30;
const EXPAND_BATCH = 20;

export const EMPTY_MESSAGES: any[] = [];

interface FontConfig {
  proseFont: string;
  proseLineHeight: number;
  codeLineHeight: number;
}

/**
 * Estimate item height. For assistant messages, uses pretext measurements when
 * available for much more accurate estimates than the flat 120px fallback.
 * containerWidth = 0 means "use flat fallback" (pretext not ready or width unknown).
 */
function estimateItemHeight(item: RenderItem, containerWidth = 0, fonts?: FontConfig): number {
  if (item.type === 'message') {
    if (item.msg.role === 'user') return 80;

    // Try pretext-based measurement for assistant messages
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
  if (item.type === 'toolcall') return 44;
  if (item.type === 'toolcall-group') return 44;
  if (item.type === 'toolcall-run') return 44 * item.items.length;
  if (item.type === 'thread-event') return 32;
  if (item.type === 'compaction-event') return 32;
  if (item.type === 'workflow-event-group') return 32;
  return 60;
}

export interface MemoizedMessageListHandle {
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
    forkingMessageId?: string | null;
    scrollRef: any;
  },
  next: typeof prev,
) {
  return (
    prev.messages === next.messages &&
    prev.threadEvents === next.threadEvents &&
    prev.compactionEvents === next.compactionEvents &&
    prev.threadId === next.threadId &&
    (prev.threadStatus === 'waiting') === (next.threadStatus === 'waiting') &&
    prev.snapshotMap === next.snapshotMap &&
    prev.onSend === next.onSend &&
    prev.onOpenLightbox === next.onOpenLightbox &&
    prev.onToolRespond === next.onToolRespond &&
    prev.onFork === next.onFork &&
    prev.forkingMessageId === next.forkingMessageId &&
    prev.scrollRef === next.scrollRef
  );
}

/** Memoized message list with windowed rendering — only mounts the last
 *  INITIAL_WINDOW items on first render, expanding progressively on scroll-up.
 *  Items are never un-mounted; contentVisibility:'auto' handles paint cost. */
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
      forkingMessageId?: string | null;
      scrollRef: React.RefObject<HTMLElement | null>;
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
      forkingMessageId,
      scrollRef,
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

    /* ── Windowed rendering ──────────────────────────────────────────── */

    // Ensure the render window is large enough to include the last user
    // message — when tool calls expand the grouped-item count well beyond
    // the raw message count, INITIAL_WINDOW (30) may not reach it.
    const effectiveInitialWindow = useMemo(() => {
      for (let i = groupedItems.length - 1; i >= 0; i--) {
        const item = groupedItems[i];
        if (item.type === 'message' && item.msg.role === 'user') {
          const needed = groupedItems.length - i + 5; // +5 buffer
          return Math.max(INITIAL_WINDOW, needed);
        }
      }
      return INITIAL_WINDOW;
    }, [groupedItems]);

    const [renderCount, setRenderCount] = useState(INITIAL_WINDOW);

    // Reset render window when switching threads (synchronous state reset
    // during render — standard React derived-state-from-props pattern).
    const prevThreadIdRef = useRef(threadId);
    if (prevThreadIdRef.current !== threadId) {
      prevThreadIdRef.current = threadId;
      setRenderCount(INITIAL_WINDOW);
    }

    // Bump renderCount when effectiveInitialWindow grows (e.g. after
    // messages load asynchronously following a thread switch).
    // Track that this expansion is window-init-driven so the
    // windowStart useLayoutEffect can scroll to bottom instead of
    // relying on a (non-existent) scroll anchor.
    const initWindowBumpRef = useRef(false);
    useEffect(() => {
      setRenderCount((prev) => {
        const next = Math.max(prev, effectiveInitialWindow);
        if (next > prev) initWindowBumpRef.current = true;
        return next;
      });
    }, [effectiveInitialWindow]);

    const windowStart = Math.max(0, groupedItems.length - renderCount);
    const visibleItems = groupedItems.slice(windowStart);
    const hasHiddenItems = windowStart > 0;

    // When windowed rendering hides items, the user message that "owns" the
    // first visible section may be above the window.  Find it so the section
    // grouping can still show a sticky header for context.
    const hiddenSectionUserItem = useMemo(() => {
      if (windowStart === 0) return null;
      // Check if the first visible item is already a user message — no need
      // to inject one in that case.
      const firstVisible = visibleItems[0];
      if (firstVisible?.type === 'message' && firstVisible.msg.role === 'user') return null;
      // Walk backwards from windowStart to find the nearest user message.
      for (let i = windowStart - 1; i >= 0; i--) {
        const item = groupedItems[i];
        if (item.type === 'message' && item.msg.role === 'user') {
          return item as Extract<RenderItem, { type: 'message' }>;
        }
      }
      return null;
    }, [groupedItems, visibleItems, windowStart]);

    // ID → index map for expandToItem (scroll-to-message support)
    const itemIndexMap = useMemo(() => {
      const map = new Map<string, number>();
      groupedItems.forEach((item, index) => {
        if (item.type === 'message') map.set(item.msg.id, index);
        else if (item.type === 'toolcall') map.set(item.tc.id, index);
        else if (item.type === 'toolcall-group')
          item.calls.forEach((c: any) => map.set(c.id, index));
        else if (item.type === 'toolcall-run') {
          for (const ti of item.items) {
            if (ti.type === 'toolcall') map.set(ti.tc.id, index);
            else if (ti.type === 'toolcall-group')
              ti.calls.forEach((c: any) => map.set(c.id, index));
          }
        } else if (item.type === 'thread-event') map.set(item.event.id, index);
      });
      return map;
    }, [groupedItems]);

    // ── Height cache: measured heights from ResizeObserver ──────────
    // Used to produce accurate spacer heights instead of estimates.
    const heightCacheRef = useRef(new Map<string, number>());
    const itemContainerRef = useRef<HTMLDivElement>(null);

    // Clear cache on thread switch
    const prevCacheThreadRef = useRef(threadId);
    if (prevCacheThreadRef.current !== threadId) {
      prevCacheThreadRef.current = threadId;
      heightCacheRef.current.clear();
    }

    // ResizeObserver: record measured heights of rendered items
    useEffect(() => {
      const container = itemContainerRef.current;
      if (!container) return;

      const cache = heightCacheRef.current;
      const ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const key = (entry.target as HTMLElement).dataset.itemKey;
          if (key) {
            const h =
              entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height;
            cache.set(key, h);
          }
        }
      });

      // Observe all current items and watch for new ones
      const observeAll = () => {
        container.querySelectorAll<HTMLElement>('[data-item-key]').forEach((el) => ro.observe(el));
      };
      observeAll();

      const mo = new MutationObserver(observeAll);
      mo.observe(container, { childList: true, subtree: true });

      return () => {
        ro.disconnect();
        mo.disconnect();
      };
    }, [threadId]);

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

    // ── Pretext warm-up: prepare assistant message texts in background ──
    const pretextReadyRef = useRef(false);
    useEffect(() => {
      let cancelled = false;
      const { proseFont } = fontConfig;

      // Ensure pretext is loaded, then prepare all uncached assistant messages
      ensurePretextLoaded().then(() => {
        if (cancelled) return;
        pretextReadyRef.current = true;

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
          prepareBatch(toPrepare, proseFont, {
            signal: cancelled ? AbortSignal.abort() : undefined,
          });
        }
      });

      return () => {
        cancelled = true;
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

    // Stable ref so scroll listeners and rAF callbacks never hit a TDZ during HMR
    const captureScrollAnchorRef = useRef(captureScrollAnchor);
    captureScrollAnchorRef.current = captureScrollAnchor;

    const restoreScrollAnchor = useCallback(() => {
      const viewport = scrollRef.current;
      const container = itemContainerRef.current;
      const anchor = scrollAnchorRef.current;
      if (!viewport || !container || !anchor) return;

      const el = container.querySelector<HTMLElement>(
        `[data-item-key="${CSS.escape(anchor.key)}"]`,
      );
      if (el) {
        const vpRect = viewport.getBoundingClientRect();
        const rect = el.getBoundingClientRect();
        const currentOffset = rect.top - vpRect.top;
        const drift = currentOffset - anchor.offsetFromViewportTop;
        viewport.scrollTop += drift;
      }
      scrollAnchorRef.current = null;
    }, [scrollRef]);

    // Spacer height for items above the render window
    const spacerHeight = useMemo(() => {
      let h = 0;
      const cache = heightCacheRef.current;
      for (let i = 0; i < windowStart; i++) {
        const key = getItemKey(groupedItems[i]);
        h += cache.get(key) ?? estimateItemHeight(groupedItems[i], containerWidth, fontConfig);
        if (i < windowStart - 1) h += 16; // space-y-4 gap
      }
      return h;
    }, [groupedItems, windowStart, containerWidth, fontConfig]);

    // Refs so the scroll listener always reads fresh values without re-attaching
    const spacerHeightRef = useRef(spacerHeight);
    spacerHeightRef.current = spacerHeight;
    const windowStartRef = useRef(windowStart);
    windowStartRef.current = windowStart;
    const groupedLenRef = useRef(groupedItems.length);
    groupedLenRef.current = groupedItems.length;

    // Expose helpers so parent can interact with the windowed list
    useImperativeHandle(
      ref,
      () => ({
        expandToItem: (id: string) => {
          const index = itemIndexMap.get(id);
          if (index !== undefined) {
            const needed = groupedItems.length - index + 5;
            if (needed > renderCount) {
              flushSync(() => setRenderCount(Math.min(groupedItems.length, needed)));
            }
          }
        },
        hasHiddenItems: () => windowStartRef.current > 0,
        captureScrollAnchor,
        restoreScrollAnchor,
      }),
      [itemIndexMap, renderCount, groupedItems.length, captureScrollAnchor, restoreScrollAnchor],
    );

    // Scroll-based window expansion
    useEffect(() => {
      const scrollEl = scrollRef.current;
      if (!scrollEl) return;

      const onScroll = () => {
        if (windowStartRef.current <= 0) return;
        if (scrollEl.scrollTop < spacerHeightRef.current + 600) {
          captureScrollAnchorRef.current();
          setRenderCount((prev) => Math.min(groupedLenRef.current, prev + EXPAND_BATCH));
        }
      };

      scrollEl.addEventListener('scroll', onScroll, { passive: true });
      return () => scrollEl.removeEventListener('scroll', onScroll);
    }, [scrollRef]);

    // After each expansion, restore the scroll anchor.
    // If the expansion came from effectiveInitialWindow growth (no anchor
    // was captured), scroll to bottom so the view stays pinned.
    useLayoutEffect(() => {
      if (initWindowBumpRef.current) {
        initWindowBumpRef.current = false;
        const viewport = scrollRef.current;
        if (viewport) {
          viewport.scrollTop = viewport.scrollHeight;
        }
      } else {
        restoreScrollAnchor();
      }
    }, [windowStart, restoreScrollAnchor, scrollRef]);

    useEffect(() => {
      if (windowStart <= 0) return;
      const scrollEl = scrollRef.current;
      if (!scrollEl) return;

      const rafId = requestAnimationFrame(() => {
        if (scrollEl.scrollTop < spacerHeightRef.current + 600) {
          captureScrollAnchorRef.current();
          setRenderCount((prev) => Math.min(groupedLenRef.current, prev + EXPAND_BATCH));
        }
      });
      return () => cancelAnimationFrame(rafId);
    }, [windowStart, scrollRef]);

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

    // Group items into sections: each section starts with a user message
    type MessageItem = Extract<RenderItem, { type: 'message' }>;
    const sections = useMemo(() => {
      const result: { userItem: MessageItem | null; items: RenderItem[] }[] = [];
      let current: { userItem: MessageItem | null; items: RenderItem[] } = {
        userItem: null,
        items: [],
      };

      for (const item of visibleItems) {
        if (item.type === 'message' && item.msg.role === 'user') {
          if (current.userItem || current.items.length > 0) {
            result.push(current);
          }
          current = { userItem: item as MessageItem, items: [] };
        } else {
          current.items.push(item);
        }
      }
      if (current.userItem || current.items.length > 0) {
        result.push(current);
      }

      if (result.length > 0 && !result[0].userItem && hiddenSectionUserItem) {
        result[0].userItem = hiddenSectionUserItem;
      }

      return result;
    }, [visibleItems, hiddenSectionUserItem]);

    const renderNonUserItem = useCallback(
      (item: RenderItem) => {
        const key = getItemKey(item);

        if (item.type === 'message') {
          const msg = item.msg;
          const estimatedH = estimateItemHeight(item, containerWidth, fontConfig);
          return (
            <div
              key={key}
              data-item-key={key}
              style={{
                contentVisibility: 'auto',
                containIntrinsicSize: `auto ${estimatedH}px`,
              }}
              className="group/msg relative w-full text-sm text-foreground"
            >
              <div className="break-words text-sm leading-relaxed">
                <div className="flex items-start gap-2">
                  {msg.author && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Avatar className="mt-0.5">
                          <AvatarFallback
                            className="text-xs font-medium text-primary"
                            name={msg.author}
                          >
                            {msg.author.slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                      </TooltipTrigger>
                      <TooltipContent side="top">{msg.author}</TooltipContent>
                    </Tooltip>
                  )}
                  <div className="min-w-0 flex-1">
                    <MessageContent content={msg.content.trim()} />
                  </div>
                  <CopyButton content={msg.content} />
                </div>
                <div className="mt-1">
                  <span className="select-none text-xs text-muted-foreground/80">
                    {timeAgo(msg.timestamp, t)}
                  </span>
                </div>
              </div>
            </div>
          );
        }

        if (item.type === 'toolcall' || item.type === 'toolcall-group') {
          const toolName = item.type === 'toolcall' ? item.tc.name : item.name;
          const isInteractive = toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode';
          return (
            <div
              key={key}
              data-item-key={key}
              style={
                isInteractive
                  ? undefined
                  : { contentVisibility: 'auto', containIntrinsicSize: 'auto 40px' }
              }
            >
              {renderToolItem(item)}
            </div>
          );
        }

        if (item.type === 'toolcall-run') {
          const runH = 44 * item.items.length;
          return (
            <div
              key={key}
              data-item-key={key}
              style={{ contentVisibility: 'auto', containIntrinsicSize: `auto ${runH}px` }}
            >
              <div className="space-y-1">{item.items.map(renderToolItem)}</div>
            </div>
          );
        }

        if (item.type === 'workflow-event-group') {
          return (
            <div
              key={key}
              data-item-key={key}
              style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 32px' }}
            >
              <WorkflowEventGroup events={item.events} />
            </div>
          );
        }

        if (item.type === 'thread-event') {
          return (
            <div
              key={key}
              data-item-key={key}
              style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 32px' }}
            >
              <GitEventCard event={item.event} />
            </div>
          );
        }

        if (item.type === 'compaction-event') {
          return (
            <div
              key={key}
              data-item-key={key}
              style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 32px' }}
            >
              <CompactionEventCard event={item.event} />
            </div>
          );
        }

        return null;
      },
      [renderToolItem, t, containerWidth, fontConfig],
    );

    const renderUserMessage = useCallback(
      (item: Extract<RenderItem, { type: 'message' }>) => {
        const msg = item.msg;
        return (
          <div
            className="sticky top-0 z-20 pb-3 pt-3"
            data-user-msg={msg.id}
            data-item-key={msg.id}
          >
            <UserMessageCard
              data-testid={`user-message-${msg.id}`}
              content={msg.content}
              images={msg.images}
              model={msg.model}
              permissionMode={msg.permissionMode}
              timestamp={msg.timestamp}
              onClick={() => {
                const section = scrollRef.current?.querySelector(
                  `[data-section-msg-id="${msg.id}"]`,
                );
                if (section) {
                  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
              }}
              onImageClick={onOpenLightbox}
              onFork={onFork ? () => onFork(msg.id) : undefined}
              forkDisabled={forkingMessageId != null}
            />
          </div>
        );
      },
      [onOpenLightbox, scrollRef, onFork, forkingMessageId],
    );

    return (
      <div ref={itemContainerRef}>
        {hasHiddenItems && <div style={{ height: spacerHeight }} aria-hidden="true" />}
        {sections.map((section, sIdx) => {
          const sectionKey = section.userItem ? getItemKey(section.userItem) : `preamble-${sIdx}`;

          // Preamble section (items before first user message) — no sticky header
          if (!section.userItem) {
            return (
              <div key={sectionKey} className="space-y-4">
                {section.items.map(renderNonUserItem)}
              </div>
            );
          }

          return (
            <div key={sectionKey} data-section-msg-id={section.userItem.msg.id}>
              {renderUserMessage(section.userItem)}
              {section.items.length > 0 && (
                <div className="space-y-4">{section.items.map(renderNonUserItem)}</div>
              )}
            </div>
          );
        })}
      </div>
    );
  }),
  messageListAreEqual,
);
