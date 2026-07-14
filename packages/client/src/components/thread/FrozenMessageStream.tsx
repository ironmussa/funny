import { useCallback, useImperativeHandle } from 'react';
import { useTranslation } from 'react-i18next';

import { FrozenMessageList } from './FrozenMessageList';
import { EMPTY_MESSAGES } from './MemoizedMessageList.constants';
import type { MessageStreamProps } from './message-stream-types';
import { MessageStreamShell } from './MessageStreamShell';
import { useFrozenScroll } from './use-frozen-scroll';

const EMPTY_SNAPSHOT_MAP = new Map<string, number>();
const EMPTY_KNOWN_IDS = new Set<string>();

/**
 * Frozen viewer container: in-flow `FrozenMessageList` + native-scroll
 * orchestration (`useFrozenScroll`) rendered through the shared
 * `MessageStreamShell`. The virtual `MessageStream` path is untouched.
 */
export function FrozenMessageStream(props: MessageStreamProps) {
  const {
    ref,
    threadId,
    status,
    messages,
    lastUserMessage,
    leadingUserMessage,
    threadEvents,
    compactionEvents,
    initInfo,
    resultInfo,
    waitingReason,
    pendingPermission,
    pendingPermissionRequest,
    permissionApprovalCapability,
    permissionRecoveryReason,
    isExternal = false,
    onSend,
    onPermissionApproval,
    onPermissionDecision,
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
    compact = false,
    footer,
    className,
  } = props;

  const { t } = useTranslation();
  const isRunning = status === 'running';

  const {
    contentStackRef,
    messageListRef,
    promptPinSpacerHeight,
    scrollDownRef,
    scrollToBottom,
    scrollViewportRef,
    topSentinelRef,
    bottomSentinelRef,
  } = useFrozenScroll({
    threadId,
    status,
    messages,
    waitingReason,
    pagination,
    compact,
    initInfo,
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

  const list = (
    <FrozenMessageList
      key={threadId}
      ref={messageListRef}
      messages={messages ?? EMPTY_MESSAGES}
      lastUserMessage={lastUserMessage}
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
  );

  return (
    <MessageStreamShell
      t={t}
      scrollViewportRef={scrollViewportRef}
      contentStackRef={contentStackRef}
      scrollDownRef={scrollDownRef}
      scrollToBottom={scrollToBottom}
      promptPinSpacerHeight={promptPinSpacerHeight}
      overflowAnchor="auto"
      list={list}
      topSentinel={
        pagination ? (
          <div ref={topSentinelRef} data-testid="frozen-top-sentinel" aria-hidden="true" />
        ) : undefined
      }
      bottomSentinel={
        pagination?.hasMoreAfter ? (
          <div ref={bottomSentinelRef} data-testid="frozen-bottom-sentinel" aria-hidden="true" />
        ) : undefined
      }
      compact={compact}
      className={className}
      messages={messages}
      pagination={pagination}
      createdAt={createdAt}
      initInfo={initInfo}
      status={status}
      waitingReason={waitingReason}
      pendingPermission={pendingPermission}
      pendingPermissionRequest={pendingPermissionRequest}
      permissionApprovalCapability={permissionApprovalCapability}
      permissionRecoveryReason={permissionRecoveryReason}
      isRunning={isRunning}
      isExternal={isExternal}
      resultInfo={resultInfo}
      model={model}
      permissionMode={permissionMode}
      onSend={onSend}
      onPermissionApprove={handlePermissionApprove}
      onPermissionAlwaysAllow={handlePermissionAlwaysAllow}
      onPermissionDeny={handlePermissionDeny}
      onPermissionDecision={onPermissionDecision}
      footer={footer}
    />
  );
}
