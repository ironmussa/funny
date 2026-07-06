import { ArrowDown } from 'lucide-react';
import { useCallback, useImperativeHandle } from 'react';
import { useTranslation } from 'react-i18next';

import { LoadingState } from '@/components/ui/loading-state';
import { timeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';

import { InitInfoCard } from './InitInfoCard';
import { MemoizedMessageList } from './MemoizedMessageList';
import { EMPTY_MESSAGES } from './MemoizedMessageList.constants';
import type { MessageStreamProps } from './message-stream-types';
import { MessageStreamStatusTail } from './MessageStreamStatusTail';
import { useMessageStreamScroll } from './use-message-stream-scroll';

export type { MessageStreamHandle, MessageStreamProps } from './message-stream-types';

const EMPTY_SNAPSHOT_MAP = new Map<string, number>();
const EMPTY_KNOWN_IDS = new Set<string>();
export function MessageStream(props: MessageStreamProps) {
  const {
    ref,
    threadId,
    status,
    messages,
    leadingUserMessage,
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
    className,
  } = props;

  const { t } = useTranslation();

  const isRunning = status === 'running';
  const hasMore = pagination?.hasMore ?? false;
  const loadingMore = pagination?.loadingMore ?? false;
  const {
    contentStackRef,
    messageListRef,
    promptPinSpacerHeight,
    scrollDownRef,
    scrollToBottom,
    scrollViewportRef,
  } = useMessageStreamScroll({
    threadId,
    status,
    messages,
    waitingReason,
    pagination,
    compact,
    initInfo,
    onVisibleMessageChange,
  });

  const noopLightbox = useCallback(
    (_images: { src: string; alt: string }[], _index: number) => {},
    [],
  );
  const effectiveOpenLightbox = onOpenLightbox ?? noopLightbox;

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
    [messageListRef, scrollToBottom, scrollViewportRef],
  );

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
        overflowAnchor: 'none',
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

        {/* Message list wrapper keeps the virtualizer scroll-margin observer stable. */}
        <div>
          <MemoizedMessageList
            key={threadId}
            ref={messageListRef}
            messages={messages ?? EMPTY_MESSAGES}
            leadingUserMessage={leadingUserMessage}
            threadEvents={threadEvents}
            compactionEvents={compactionEvents}
            threadId={threadId}
            threadStatus={status}
            knownIds={knownIds}
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
          onPermissionApprove={handlePermissionApprove}
          onPermissionAlwaysAllow={handlePermissionAlwaysAllow}
          onPermissionDeny={handlePermissionDeny}
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
