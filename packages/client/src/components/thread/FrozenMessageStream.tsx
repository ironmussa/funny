import { useTranslation } from 'react-i18next';

import { FrozenMessageList } from './FrozenMessageList';
import type { MessageStreamProps } from './message-stream-types';
import { MessageStreamShell } from './MessageStreamShell';
import { useFrozenScroll } from './use-frozen-scroll';
import { useMessageStreamList } from './use-message-stream-list';

/**
 * Frozen viewer container: in-flow `FrozenMessageList` + native-scroll
 * orchestration (`useFrozenScroll`) rendered through the shared
 * `MessageStreamShell`. The virtual `MessageStream` path is untouched.
 */
export function FrozenMessageStream(props: MessageStreamProps) {
  const {
    threadId,
    status,
    messages,
    lastUserMessage,
    initInfo,
    resultInfo,
    waitingReason,
    pendingPermission,
    pendingPermissionRequest,
    permissionApprovalCapability,
    permissionRecoveryReason,
    isExternal = false,
    onSend,
    onPermissionDecision,
    model = '',
    permissionMode = '',
    pagination,
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

  const { listProps, handlePermissionApprove, handlePermissionAlwaysAllow, handlePermissionDeny } =
    useMessageStreamList(props, { messageListRef, scrollViewportRef, scrollToBottom });
  const list = (
    <FrozenMessageList key={threadId} {...listProps} lastUserMessage={lastUserMessage} />
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
      lastUserMessage={lastUserMessage}
      pagination={pagination}
      status={status}
      waitingReason={waitingReason}
      pendingPermission={pendingPermission}
      pendingPermissionRequest={pendingPermissionRequest}
      permissionApprovalCapability={permissionApprovalCapability}
      permissionRecoveryReason={permissionRecoveryReason}
      isRunning={isRunning}
      isExternal={isExternal}
      resultInfo={resultInfo}
      completedAt={props.completedAt}
      copyThreadId={threadId}
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
