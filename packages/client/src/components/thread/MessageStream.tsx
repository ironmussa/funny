import type { ThreadEvent, WaitingReason } from '@funny/shared';
import { ArrowDown, Clock } from 'lucide-react';
import { m, useReducedMotion } from 'motion/react';
import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  forwardRef,
  useImperativeHandle,
} from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { LoadingState } from '@/components/ui/loading-state';
import { timeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';
import { selectLastMessage, selectFirstMessage } from '@/stores/thread-selectors';
import type { CompactionEvent, AgentInitInfo } from '@/stores/thread-store';

import { D4CAnimation } from '../D4CAnimation';
import { AgentResultCard, AgentInterruptedCard, AgentStoppedCard } from './AgentStatusCards';
import { InitInfoCard } from './InitInfoCard';
import {
  MemoizedMessageList,
  EMPTY_MESSAGES,
  type MemoizedMessageListHandle,
} from './MemoizedMessageList';
import { WaitingActions, PermissionApprovalCard, ProviderErrorCard } from './WaitingCards';

/* ── Types ────────────────────────────────────────────────────────── */

export interface MessageStreamProps {
  /** Thread ID — used for keying scroll state */
  threadId: string;
  /** Thread status */
  status: string;
  /** Messages array */
  messages: any[];
  /** Thread events for interleaving */
  threadEvents?: ThreadEvent[];
  /** Compaction events */
  compactionEvents?: CompactionEvent[];
  /** Agent init info card data */
  initInfo?: AgentInitInfo;
  /** Agent result info */
  resultInfo?: { status: 'completed' | 'failed'; cost: number; duration: number; error?: string };
  /** Waiting reason when status=waiting */
  waitingReason?: WaitingReason;
  /** Pending permission data */
  pendingPermission?: { toolName: string; toolInput?: string };
  /** Whether agent runs on an external provider */
  isExternal?: boolean;
  /** Send handler — called by status cards and tool card onRespond */
  onSend: (prompt: string, opts: { model: string; mode: string }) => void;
  /** Permission approval handler (alwaysAllow=true persists the decision) */
  onPermissionApproval?: (toolName: string, approved: boolean, alwaysAllow?: boolean) => void;
  /** Tool respond handler (AskUserQuestion / ExitPlanMode) — if omitted, respond buttons won't show */
  onToolRespond?: (toolCallId: string, answer: string, toolName: string) => void;
  /** Fork the thread starting from a specific user message — if omitted, the fork button is hidden */
  onFork?: (messageId: string) => void;
  /** Rewind code (and conversation) to a specific user message in place */
  onRewind?: (messageId: string) => void;
  /** Fork the conversation AND rewind code on the new fork */
  onForkAndRewind?: (messageId: string) => void;
  /** ID of the user message currently being forked (disables other fork buttons) */
  forkingMessageId?: string | null;
  /** When true, rewind menu items render disabled with `rewindDisabledReason` as tooltip */
  rewindDisabled?: boolean;
  rewindDisabledReason?: string;
  /** Model and permission mode for passing to onSend from status cards */
  model?: string;
  permissionMode?: string;
  /** Per-session changed files keyed by the session's user-message id — renders a
   *  changed-files summary at the end of each session. */
  sessionChanges?: Map<string, import('@funny/shared').FileDiffSummary[]>;
  /** Called after a revert inside a session summary so diff data refetches. */
  onSessionReverted?: () => void;

  // ── Optional advanced features ──

  /** Pagination support — when omitted, no pagination UI is shown */
  pagination?: {
    hasMore: boolean;
    loadingMore: boolean;
    load: () => void;
    /** Full message count for the thread — sizes the phantom spacer that
     *  reserves scroll height for older messages not yet loaded. */
    total?: number;
  };
  /** Thread creation timestamp */
  createdAt?: string;
  /** Todo snapshot map */
  snapshotMap?: Map<string, number>;
  /** Known IDs set for skipping entrance animations */
  knownIds?: Set<string>;
  /** Lightbox opener callback */
  onOpenLightbox?: (images: { src: string; alt: string }[], index: number) => void;
  /** Visible message change callback (for timeline) */
  onVisibleMessageChange?: (id: string) => void;
  /** Compact mode for grid columns */
  compact?: boolean;
  /** Footer slot — PromptInput goes here */
  footer?: React.ReactNode;
  /** Override reduced motion preference */
  prefersReducedMotion?: boolean | null;
  /** CSS class for outermost container */
  className?: string;
}

export interface MessageStreamHandle {
  scrollToBottom: () => void;
  scrollViewport: HTMLDivElement | null;
  expandToItem: (id: string) => void;
  hasHiddenItems: () => boolean;
  captureScrollAnchor: () => void;
  restoreScrollAnchor: () => void;
}

const EMPTY_SNAPSHOT_MAP = new Map<string, number>();
const EMPTY_KNOWN_IDS = new Set<string>();

// Fallback per-message height before we've measured the real rendered content.
const DEFAULT_MSG_HEIGHT_PX = 140;
// Clamp the measured average to sane bounds so one freak message (or an empty
// container mid-mount) can't blow the phantom spacer up or collapse it.
const MIN_MSG_HEIGHT_PX = 24;
const MAX_MSG_HEIGHT_PX = 2000;

/* ── Component ────────────────────────────────────────────────────── */

export const MessageStream = forwardRef<MessageStreamHandle, MessageStreamProps>(
  function MessageStream(props, ref) {
    const {
      threadId,
      status,
      messages,
      threadEvents,
      compactionEvents,
      initInfo,
      resultInfo,
      waitingReason,
      pendingPermission,
      isExternal = false,
      onSend,
      onPermissionApproval,
      onToolRespond,
      onFork,
      onRewind,
      onForkAndRewind,
      forkingMessageId,
      rewindDisabled,
      rewindDisabledReason,
      model = '',
      permissionMode = '',
      sessionChanges,
      onSessionReverted,
      pagination,
      createdAt,
      snapshotMap = EMPTY_SNAPSHOT_MAP,
      knownIds = EMPTY_KNOWN_IDS,
      onOpenLightbox,
      onVisibleMessageChange,
      compact = false,
      footer,
      prefersReducedMotion: prefersReducedMotionProp,
      className,
    } = props;

    const { t } = useTranslation();
    const systemReducedMotion = useReducedMotion();
    const prefersReducedMotion = prefersReducedMotionProp ?? systemReducedMotion;

    const isRunning = status === 'running';
    const hasMore = pagination?.hasMore ?? false;
    const loadingMore = pagination?.loadingMore ?? false;
    const totalMessages = pagination?.total ?? 0;
    const loadedCount = messages?.length ?? 0;
    // How many older messages exist on the server that we haven't loaded yet.
    // Only meaningful while there's more to fetch — once hasMore is false the
    // loaded window IS the whole conversation, so reserve nothing.
    const unloadedCount = hasMore ? Math.max(0, totalMessages - loadedCount) : 0;

    // ── Scroll refs ──────────────────────────────────────────────────
    const scrollViewportRef = useRef<HTMLDivElement>(null);
    const userHasScrolledUp = useRef(false);
    const smoothScrollPending = useRef(false);
    const scrollingToBottomRef = useRef(false);
    const scrolledThreadRef = useRef<string | null>(null);
    const prevOldestIdRef = useRef<string | null>(null);
    const prevScrollHeightRef = useRef(0);
    const scrollDownRef = useRef<HTMLDivElement>(null);
    const contentStackRef = useRef<HTMLDivElement>(null);
    const messageListRef = useRef<MemoizedMessageListHandle>(null);

    // ── Phantom spacer for not-yet-loaded older messages ─────────────
    // Reserves scroll height above the loaded window so the scrollbar is sized
    // to the whole conversation, not just the loaded chunk. As pages load, the
    // phantom shrinks while real content grows by ~the same amount, so total
    // scroll height (and the thumb) stays stable instead of jumping.
    const listWrapperRef = useRef<HTMLDivElement>(null);
    // Running estimate of pixels per loaded message; refined from measurements.
    const avgMsgHeightRef = useRef(DEFAULT_MSG_HEIGHT_PX);
    const [phantomHeight, setPhantomHeight] = useState(0);
    const phantomHeightRef = useRef(0);
    phantomHeightRef.current = phantomHeight;
    const prevPhantomAppliedRef = useRef(0);
    const prevThreadForPhantomRef = useRef(threadId);
    // Reset the phantom synchronously when the thread changes (render-phase
    // adjust-state-on-prop-change pattern) so a tall conversation's spacer never
    // paints into the next thread before its own total/height is measured.
    if (prevThreadForPhantomRef.current !== threadId) {
      prevThreadForPhantomRef.current = threadId;
      avgMsgHeightRef.current = DEFAULT_MSG_HEIGHT_PX;
      prevPhantomAppliedRef.current = 0;
      if (phantomHeight !== 0) setPhantomHeight(0);
    }

    // Prompt pinning (full mode only)
    const pinnedPromptIdRef = useRef<string | null>(null);
    const [promptPinSpacerHeight, setPromptPinSpacerHeight] = useState(0);
    const promptPinSpacerHeightRef = useRef(0);
    promptPinSpacerHeightRef.current = promptPinSpacerHeight;

    // ── Lightbox fallback ────────────────────────────────────────────
    const noopLightbox = useCallback(
      (_images: { src: string; alt: string }[], _index: number) => {},
      [],
    );
    const effectiveOpenLightbox = onOpenLightbox ?? noopLightbox;

    // ── Visible message tracking ref ─────────────────────────────────
    const lastUserMsgIdRef = useRef<string | null>(null);
    useEffect(() => {
      if (!messages?.length) {
        lastUserMsgIdRef.current = null;
        return;
      }
      const last = messages.filter((m: any) => m.role === 'user' && m.content?.trim()).at(-1);
      lastUserMsgIdRef.current = last?.id ?? null;
    }, [messages]);

    // ── Thread switch: scroll to bottom ──────────────────────────────
    useLayoutEffect(() => {
      const viewport = scrollViewportRef.current;
      if (!viewport || !threadId) return;

      userHasScrolledUp.current = false;
      prevOldestIdRef.current = null;
      prevScrollHeightRef.current = 0;
      pinnedPromptIdRef.current = null;
      scrolledThreadRef.current = null;
      setPromptPinSpacerHeight(0);
      const rafId = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          viewport.scrollTop = viewport.scrollHeight;
        });
      });
      return () => cancelAnimationFrame(rafId);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [threadId]);

    // ── Scroll fingerprint — triggers sticky-bottom logic ────────────
    const threadData = { messages, status } as any;
    const lastMessage = selectLastMessage(threadData);

    const lastUserMessageId = useMemo(() => {
      if (!messages?.length) return null;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') return messages[i].id;
      }
      return null;
    }, [messages]);
    const prevLastUserMessageIdRef = useRef(lastUserMessageId);
    const prevWaitingReasonRef = useRef(waitingReason);

    const scrollFingerprint = [
      lastMessage?.id,
      lastMessage?.content?.length,
      lastMessage?.toolCalls?.length,
      status,
      waitingReason ?? '',
      !!initInfo,
    ].join(':');

    // ── Scroll event handler ─────────────────────────────────────────
    useEffect(() => {
      const viewport = scrollViewportRef.current;
      if (!viewport) return;

      const handleScroll = () => {
        const { scrollTop, scrollHeight, clientHeight } = viewport;
        const hasOverflow = scrollHeight > clientHeight + 10;
        const promptPinned = !compact && promptPinSpacerHeightRef.current > 0;
        const isAtBottom = scrollHeight - scrollTop - clientHeight <= 80;

        if (!scrollingToBottomRef.current) {
          userHasScrolledUp.current = promptPinned || !isAtBottom;
        } else if (isAtBottom) {
          scrollingToBottomRef.current = false;
          userHasScrolledUp.current = false;
        }

        // Update scroll-to-bottom button visibility via DOM
        const shouldShow = hasOverflow && !isAtBottom && !scrollingToBottomRef.current;
        if (scrollDownRef.current) {
          scrollDownRef.current.style.display = shouldShow ? '' : 'none';
        }

        // Load older messages when scrolled near the top of the loaded window.
        // The phantom spacer pushes real content down by its height, so the
        // trigger zone shifts down with it.
        if (
          pagination &&
          scrollTop < phantomHeightRef.current + 200 &&
          hasMore &&
          !loadingMore &&
          !messageListRef.current?.hasHiddenItems()
        ) {
          messageListRef.current?.captureScrollAnchor();
          pagination.load();
        }

        // At-bottom: sync visible message ID to last user message
        if (!compact && isAtBottom && lastUserMsgIdRef.current && onVisibleMessageChange) {
          onVisibleMessageChange(lastUserMsgIdRef.current);
        }
      };

      viewport.addEventListener('scroll', handleScroll, { passive: true });
      return () => viewport.removeEventListener('scroll', handleScroll);
    }, [threadId, hasMore, loadingMore, pagination, compact, onVisibleMessageChange]);

    // ── IntersectionObserver for visible message tracking (non-compact) ──
    useEffect(() => {
      if (compact || !onVisibleMessageChange) return;
      const viewport = scrollViewportRef.current;
      if (!viewport || !threadId) return;

      const io = new IntersectionObserver(
        (entries) => {
          if (!userHasScrolledUp.current) return;
          for (const entry of entries) {
            if (entry.isIntersecting) {
              const id = (entry.target as HTMLElement).dataset.userMsg;
              if (id) onVisibleMessageChange(id);
            }
          }
        },
        { root: viewport, rootMargin: '-35% 0px -55% 0px', threshold: [0] },
      );

      const observeAll = () => {
        io.disconnect();
        viewport.querySelectorAll<HTMLElement>('[data-user-msg]').forEach((el) => io.observe(el));
      };
      observeAll();

      let debounceTimer: ReturnType<typeof setTimeout>;
      const mo = new MutationObserver(() => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(observeAll, 200);
      });
      mo.observe(viewport, { childList: true, subtree: true });

      return () => {
        io.disconnect();
        mo.disconnect();
        clearTimeout(debounceTimer);
      };
    }, [threadId, compact, onVisibleMessageChange]);

    // ── Sticky-bottom scroll logic ───────────────────────────────────
    useLayoutEffect(() => {
      const isNewThread = threadId != null && scrolledThreadRef.current !== threadId;
      if (isNewThread) {
        scrolledThreadRef.current = threadId;
      }
      smoothScrollPending.current = false;

      const hasNewUserMessage =
        lastUserMessageId != null && lastUserMessageId !== prevLastUserMessageIdRef.current;
      prevLastUserMessageIdRef.current = lastUserMessageId;

      const curWaiting = waitingReason;
      const prevWaiting = prevWaitingReasonRef.current;
      prevWaitingReasonRef.current = curWaiting;
      const needsAttention =
        (curWaiting === 'question' || curWaiting === 'permission') && curWaiting !== prevWaiting;

      if (isNewThread) {
        const viewport = scrollViewportRef.current;
        if (viewport) {
          userHasScrolledUp.current = false;
          scrollingToBottomRef.current = true;
          requestAnimationFrame(() => {
            viewport.scrollTop = viewport.scrollHeight;
            requestAnimationFrame(() => {
              viewport.scrollTop = viewport.scrollHeight;
              scrollingToBottomRef.current = false;
            });
          });
        }
      } else if (hasNewUserMessage) {
        // In full mode, ThreadView handles prompt pinning externally.
        // Here we just ensure the user message is visible.
        const viewport = scrollViewportRef.current;
        if (viewport) {
          userHasScrolledUp.current = false;
          scrollingToBottomRef.current = true;
          requestAnimationFrame(() => {
            viewport.scrollTop = viewport.scrollHeight;
            requestAnimationFrame(() => {
              viewport.scrollTop = viewport.scrollHeight;
              scrollingToBottomRef.current = false;
            });
          });
        }
      } else if (needsAttention) {
        const viewport = scrollViewportRef.current;
        if (viewport) {
          userHasScrolledUp.current = false;
          requestAnimationFrame(() => {
            viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
          });
        }
      } else if (!userHasScrolledUp.current && !loadingMore) {
        const viewport = scrollViewportRef.current;
        if (viewport) {
          const { scrollTop, scrollHeight, clientHeight } = viewport;
          const actuallyAtBottom = scrollHeight - scrollTop - clientHeight <= 80;
          if (!actuallyAtBottom) {
            userHasScrolledUp.current = true;
          } else {
            requestAnimationFrame(() => {
              viewport.scrollTop = viewport.scrollHeight;
              requestAnimationFrame(() => {
                if (!userHasScrolledUp.current) {
                  viewport.scrollTop = viewport.scrollHeight;
                }
              });
            });
          }
        }
      }
    }, [threadId, waitingReason, lastUserMessageId, loadingMore, scrollFingerprint]);

    // ── Pagination scroll preservation ───────────────────────────────
    const firstMessageId = selectFirstMessage({ messages } as any)?.id ?? null;
    useLayoutEffect(() => {
      if (!pagination) return;
      const oldestId = firstMessageId;
      const viewport = scrollViewportRef.current;

      if (viewport && prevOldestIdRef.current && oldestId && prevOldestIdRef.current !== oldestId) {
        userHasScrolledUp.current = true;
        messageListRef.current?.restoreScrollAnchor();

        const addedHeight = viewport.scrollHeight - prevScrollHeightRef.current;
        if (addedHeight > 0 && !messageListRef.current) {
          viewport.scrollTop += addedHeight;
        }
      }

      prevOldestIdRef.current = oldestId;
      if (viewport) {
        prevScrollHeightRef.current = viewport.scrollHeight;
      }
    }, [firstMessageId, pagination]);

    // ── Phantom spacer sizing ────────────────────────────────────────
    // The MemoizedMessageList wrapper height already approximates the FULL
    // loaded-content height (its internal spacer stands in for windowed-out
    // items), so wrapperHeight / loadedCount is a good per-message estimate.
    const recomputePhantom = useCallback(() => {
      const wrapper = listWrapperRef.current;
      if (wrapper && loadedCount > 0) {
        const measured = wrapper.offsetHeight / loadedCount;
        if (measured > 0) {
          avgMsgHeightRef.current = Math.min(
            MAX_MSG_HEIGHT_PX,
            Math.max(MIN_MSG_HEIGHT_PX, measured),
          );
        }
      }
      const next = unloadedCount > 0 ? Math.round(unloadedCount * avgMsgHeightRef.current) : 0;
      setPhantomHeight((prev) => (Math.abs(prev - next) > 1 ? next : prev));
    }, [loadedCount, unloadedCount]);

    // Recompute when the loaded/unloaded counts change.
    useLayoutEffect(() => {
      recomputePhantom();
    }, [recomputePhantom]);

    // Re-measure as the rendered list grows (items mount / heights settle).
    useEffect(() => {
      const wrapper = listWrapperRef.current;
      if (!wrapper) return;
      const ro = new ResizeObserver(() => recomputePhantom());
      ro.observe(wrapper);
      return () => ro.disconnect();
    }, [recomputePhantom]);

    // Keep the viewport visually anchored when the phantom resizes. The phantom
    // sits at the very top, so growing/shrinking it by `delta` shifts everything
    // below by `delta`; matching scrollTop keeps the read position (and the
    // bottom pin) stable instead of lurching. Pagination commits (firstMessageId
    // changed) are owned by restoreScrollAnchor, which measures the true drift
    // including the phantom shrink — so we skip those to avoid double-correcting.
    const prevFirstIdForPhantomRef = useRef(firstMessageId);
    useLayoutEffect(() => {
      const prevPhantom = prevPhantomAppliedRef.current;
      prevPhantomAppliedRef.current = phantomHeight;
      const firstChanged = prevFirstIdForPhantomRef.current !== firstMessageId;
      prevFirstIdForPhantomRef.current = firstMessageId;

      if (firstChanged) return;
      const delta = phantomHeight - prevPhantom;
      if (delta === 0) return;
      const viewport = scrollViewportRef.current;
      if (viewport) viewport.scrollTop += delta;
    }, [phantomHeight, firstMessageId]);

    // ── scrollToBottom callback ───────────────────────────────────────
    const scrollToBottom = useCallback(() => {
      const viewport = scrollViewportRef.current;
      if (!viewport) return;

      if (!compact && promptPinSpacerHeightRef.current !== 0) {
        pinnedPromptIdRef.current = null;
        flushSync(() => setPromptPinSpacerHeight(0));
      }

      scrollingToBottomRef.current = true;
      userHasScrolledUp.current = false;
      if (scrollDownRef.current) scrollDownRef.current.style.display = 'none';

      viewport.scrollTop = viewport.scrollHeight;

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!scrollingToBottomRef.current) return;
          viewport.scrollTop = viewport.scrollHeight;
          scrollingToBottomRef.current = false;
        });
      });
    }, [compact]);

    // ── Imperative handle ────────────────────────────────────────────
    useImperativeHandle(
      ref,
      () => ({
        scrollToBottom,
        get scrollViewport() {
          return scrollViewportRef.current;
        },
        expandToItem: (id: string) => messageListRef.current?.expandToItem(id),
        hasHiddenItems: () => messageListRef.current?.hasHiddenItems() ?? false,
        captureScrollAnchor: () => messageListRef.current?.captureScrollAnchor(),
        restoreScrollAnchor: () => messageListRef.current?.restoreScrollAnchor(),
      }),
      [scrollToBottom],
    );

    // ── Permission handlers ──────────────────────────────────────────
    const handlePermissionApprove = useCallback(() => {
      if (pendingPermission && onPermissionApproval) {
        onPermissionApproval(pendingPermission.toolName, true);
      }
    }, [pendingPermission, onPermissionApproval]);

    const handlePermissionAlwaysAllow = useCallback(() => {
      if (pendingPermission && onPermissionApproval) {
        onPermissionApproval(pendingPermission.toolName, true, true);
      }
    }, [pendingPermission, onPermissionApproval]);

    const handlePermissionDeny = useCallback(() => {
      if (pendingPermission && onPermissionApproval) {
        onPermissionApproval(pendingPermission.toolName, false);
      }
    }, [pendingPermission, onPermissionApproval]);

    // ── Render ───────────────────────────────────────────────────────
    return (
      <div
        className={cn(
          'flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto',
          className,
        )}
        ref={scrollViewportRef}
        style={{ contain: 'layout style', scrollbarGutter: compact ? undefined : 'stable' }}
      >
        {/* Spacer pushes content to bottom */}
        <div className="grow" aria-hidden="true" />

        <div
          ref={contentStackRef}
          className={cn(
            'mx-auto w-full min-w-0 max-w-3xl space-y-4 px-4 py-4',
            compact && 'space-y-2 px-2 py-2',
          )}
        >
          {/* Phantom spacer: reserves scroll height for older messages not yet
              loaded, so the scrollbar reflects the whole conversation and the
              thumb doesn't jump as pages stream in. */}
          {phantomHeight > 0 && (
            <div
              aria-hidden="true"
              data-testid="message-stream-phantom-spacer"
              style={{ height: phantomHeight }}
            />
          )}

          {/* Loading indicator (pagination) */}
          {pagination?.loadingMore && (
            <LoadingState
              fill={false}
              layout="inline"
              size="compact"
              className="py-3"
              testId="message-stream-loading-more"
              label={t('thread.loadingOlder', 'Loading older messages\u2026')}
            />
          )}

          {/* Beginning of conversation marker */}
          {pagination && !hasMore && !loadingMore && messages.length > 0 && (
            <div className="py-2 text-center">
              <span className="text-muted-foreground text-xs">
                {t('thread.beginningOfConversation', 'Beginning of conversation')}
                {createdAt && <> &middot; {timeAgo(createdAt, t)}</>}
              </span>
            </div>
          )}

          {/* Init info card */}
          {initInfo && (
            <InitInfoCard
              initInfo={initInfo}
              effort={messages?.find((m: any) => m.role === 'user')?.effort}
            />
          )}

          {/* Message list — wrapped so we can measure its full height for the
              phantom spacer's per-message estimate. */}
          <div ref={listWrapperRef}>
            <MemoizedMessageList
              ref={messageListRef}
              messages={messages ?? EMPTY_MESSAGES}
              threadEvents={threadEvents}
              compactionEvents={compactionEvents}
              threadId={threadId}
              threadStatus={status}
              knownIds={knownIds}
              prefersReducedMotion={prefersReducedMotion}
              snapshotMap={snapshotMap}
              onSend={onSend}
              onOpenLightbox={effectiveOpenLightbox}
              onToolRespond={onToolRespond}
              onFork={onFork}
              onRewind={onRewind}
              onForkAndRewind={onForkAndRewind}
              forkingMessageId={forkingMessageId}
              rewindDisabled={rewindDisabled}
              rewindDisabledReason={rewindDisabledReason}
              scrollRef={scrollViewportRef}
              sessionChanges={sessionChanges}
              changeSummaryRunning={isRunning}
              onSessionReverted={onSessionReverted}
            />
          </div>

          {/* Running indicator */}
          {isRunning && !isExternal && (
            <m.div
              initial={prefersReducedMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
              className="text-muted-foreground flex items-center gap-2.5 py-1 text-sm"
            >
              <D4CAnimation size={compact ? 'sm' : undefined} />
              <span className="text-xs">{t('thread.agentWorking')}</span>
            </m.div>
          )}

          {isRunning && isExternal && (
            <m.div
              initial={prefersReducedMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
              className="text-muted-foreground flex items-center gap-2.5 py-1 text-sm"
            >
              <div className="flex items-center gap-1">
                <span className="bg-muted-foreground/60 inline-block size-1.5 animate-[thinking_1.4s_ease-in-out_infinite] rounded-full" />
                <span className="bg-muted-foreground/60 inline-block size-1.5 animate-[thinking_1.4s_ease-in-out_0.2s_infinite] rounded-full" />
                <span className="bg-muted-foreground/60 inline-block size-1.5 animate-[thinking_1.4s_ease-in-out_0.4s_infinite] rounded-full" />
              </div>
              <span className="text-xs">
                {t('thread.runningExternally', 'Running externally\u2026')}
              </span>
            </m.div>
          )}

          {/* Waiting: question */}
          {status === 'waiting' && waitingReason === 'question' && (
            <m.div
              initial={prefersReducedMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
              className="text-status-warning/80 flex items-center gap-2 text-xs"
            >
              <Clock className="size-3.5 animate-pulse text-yellow-400" />
              {t('thread.waitingForResponse')}
            </m.div>
          )}

          {/* Waiting: permission */}
          {status === 'waiting' && waitingReason === 'permission' && pendingPermission && (
            <m.div
              initial={prefersReducedMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
            >
              <PermissionApprovalCard
                toolName={pendingPermission.toolName}
                toolInput={pendingPermission.toolInput}
                onApprove={handlePermissionApprove}
                onAlwaysAllow={handlePermissionAlwaysAllow}
                onDeny={handlePermissionDeny}
              />
            </m.div>
          )}

          {/* Waiting: provider error (rate limit / API error) */}
          {status === 'waiting' && waitingReason === 'provider_error' && (
            <m.div
              initial={prefersReducedMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
            >
              <ProviderErrorCard onSend={(text) => onSend(text, { model, mode: permissionMode })} />
            </m.div>
          )}

          {/* Waiting: no specific reason */}
          {status === 'waiting' && !waitingReason && (
            <m.div
              initial={prefersReducedMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
            >
              <WaitingActions onSend={(text) => onSend(text, { model, mode: permissionMode })} />
            </m.div>
          )}

          {/* Result card */}
          {resultInfo && !isRunning && status !== 'stopped' && status !== 'interrupted' && (
            <m.div
              initial={prefersReducedMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
            >
              <AgentResultCard
                status={resultInfo.status}
                cost={resultInfo.cost}
                duration={resultInfo.duration}
                error={resultInfo.error}
                onContinue={
                  resultInfo.status === 'failed'
                    ? () => onSend('Continue', { model, mode: permissionMode })
                    : undefined
                }
              />
            </m.div>
          )}

          {/* Interrupted card */}
          {status === 'interrupted' && (
            <m.div
              initial={prefersReducedMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
            >
              <AgentInterruptedCard
                onContinue={() => onSend('Continue', { model, mode: permissionMode })}
              />
            </m.div>
          )}

          {/* Stopped card */}
          {status === 'stopped' && (
            <m.div
              initial={prefersReducedMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
            >
              <AgentStoppedCard
                onContinue={() => onSend('Continue', { model, mode: permissionMode })}
              />
            </m.div>
          )}

          {/* Prompt pin spacer (full mode only) */}
          {!compact && promptPinSpacerHeight > 0 && (
            <div aria-hidden="true" style={{ height: promptPinSpacerHeight }} />
          )}
        </div>

        {/* Sticky bottom dock: scroll-to-bottom button + footer (PromptInput) */}
        <div className="bg-background sticky bottom-0 z-30">
          {/* Scroll to bottom button */}
          <div ref={scrollDownRef} className="relative" style={{ display: 'none' }}>
            <button
              onClick={scrollToBottom}
              data-testid="scroll-to-bottom"
              aria-label={t('thread.scrollToBottom', 'Scroll to bottom')}
              className="border-muted-foreground/40 bg-secondary text-muted-foreground hover:bg-muted absolute bottom-full left-1/2 mb-2 flex -translate-x-1/2 items-center gap-1 rounded-full border px-3 py-1.5 text-xs shadow-md transition-colors"
            >
              <ArrowDown className="icon-xs" />
              {t('thread.scrollToBottom', 'Scroll to bottom')}
            </button>
          </div>
          {footer}
        </div>
      </div>
    );
  },
);
