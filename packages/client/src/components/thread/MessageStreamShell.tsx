import type { TFunction } from 'i18next';
import { ArrowDown } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';

import { LoadingState } from '@/components/ui/loading-state';
import { timeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';

import { InitInfoCard } from './InitInfoCard';
import type { MessageStreamProps } from './message-stream-types';
import { MessageStreamStatusTail } from './MessageStreamStatusTail';

interface MessageStreamShellProps {
  t: TFunction;
  scrollViewportRef: RefObject<HTMLDivElement | null>;
  contentStackRef: RefObject<HTMLDivElement | null>;
  scrollDownRef: RefObject<HTMLDivElement | null>;
  scrollToBottom: () => void;
  promptPinSpacerHeight: number;
  /** `none` for the virtual list (manual anchoring), `auto` for the frozen list
   *  (native scroll anchoring keeps position during prepend/streaming). */
  overflowAnchor: 'none' | 'auto';
  /** The message list itself (virtual or frozen). */
  list: ReactNode;
  /** Optional infinite-scroll sentinels (frozen viewer). */
  topSentinel?: ReactNode;
  bottomSentinel?: ReactNode;
  compact: boolean;
  className?: string;
  // Chrome data
  messages: any[];
  pagination: MessageStreamProps['pagination'];
  createdAt?: string;
  initInfo: MessageStreamProps['initInfo'];
  status: string;
  waitingReason: MessageStreamProps['waitingReason'];
  pendingPermission: MessageStreamProps['pendingPermission'];
  isRunning: boolean;
  isExternal: boolean;
  resultInfo: MessageStreamProps['resultInfo'];
  model: string;
  permissionMode: string;
  onSend: MessageStreamProps['onSend'];
  onPermissionApprove: () => void;
  onPermissionAlwaysAllow: () => void;
  onPermissionDeny: () => void;
  footer?: ReactNode;
}

/**
 * Presentational shell shared by the virtual and frozen message streams: the
 * scroll viewport, bottom-aligned content stack (pagination chrome, init card,
 * the list, status tail, prompt spacer) and the sticky bottom dock. The two
 * viewers differ only in their scroll behavior (which hook fills the refs), the
 * `overflowAnchor` mode, the `list` node, and the optional sentinels — so the
 * DOM stays identical for the virtual path.
 */
export function MessageStreamShell({
  t,
  scrollViewportRef,
  contentStackRef,
  scrollDownRef,
  scrollToBottom,
  promptPinSpacerHeight,
  overflowAnchor,
  list,
  topSentinel,
  bottomSentinel,
  compact,
  className,
  messages,
  pagination,
  createdAt,
  initInfo,
  status,
  waitingReason,
  pendingPermission,
  isRunning,
  isExternal,
  resultInfo,
  model,
  permissionMode,
  onSend,
  onPermissionApprove,
  onPermissionAlwaysAllow,
  onPermissionDeny,
  footer,
}: MessageStreamShellProps) {
  const hasMore = pagination?.hasMore ?? false;
  const loadingMore = pagination?.loadingMore ?? false;

  return (
    <div
      className={cn(
        'flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto',
        className,
      )}
      ref={scrollViewportRef}
      style={{
        contain: 'layout style',
        scrollbarGutter: compact ? undefined : 'stable',
        overscrollBehaviorY: 'contain',
        overflowAnchor,
      }}
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
        {topSentinel}

        {/* Loading indicator (pagination) */}
        {pagination?.loadingMore && (
          <LoadingState
            fill={false}
            layout="inline"
            size="compact"
            className="py-3"
            testId="message-stream-loading-more"
            label={t('thread.loadingOlder', 'Loading older messages…')}
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

        {/* Message list wrapper keeps the virtualizer scroll-margin observer stable. */}
        <div>{list}</div>

        {bottomSentinel}

        <MessageStreamStatusTail
          status={status}
          waitingReason={waitingReason}
          pendingPermission={pendingPermission}
          isRunning={isRunning}
          isExternal={isExternal}
          compact={compact}
          resultInfo={resultInfo}
          model={model}
          permissionMode={permissionMode}
          t={t}
          onSend={onSend}
          onPermissionApprove={onPermissionApprove}
          onPermissionAlwaysAllow={onPermissionAlwaysAllow}
          onPermissionDeny={onPermissionDeny}
        />

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
            type="button"
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
}
