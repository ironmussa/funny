import { useTranslation } from 'react-i18next';

import { useSettingsStore } from '@/stores/settings-store';

import { FrozenMessageStream } from './FrozenMessageStream';
import { MemoizedMessageList } from './MemoizedMessageList';
import type { MessageStreamProps } from './message-stream-types';
import { MessageStreamShell } from './MessageStreamShell';
import { useMessageStreamList } from './use-message-stream-list';
import { useMessageStreamScroll } from './use-message-stream-scroll';

export type { MessageStreamHandle, MessageStreamProps } from './message-stream-types';

/**
 * Virtual viewer container: the TanStack Virtual `MemoizedMessageList` plus its
 * manual-anchoring scroll hook, rendered through the shared shell. This is the
 * default path and is behaviorally unchanged from before the shell extraction.
 */
function VirtualMessageStream(props: MessageStreamProps) {
  const {
    threadId,
    status,
    messages,
    lastUserMessage,
    initInfo,
    resultInfo,
    completedAt,
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
    onVisibleMessageChange,
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

  const { listProps, handlePermissionApprove, handlePermissionAlwaysAllow, handlePermissionDeny } =
    useMessageStreamList(props, { messageListRef, scrollViewportRef, scrollToBottom });
  const list = <MemoizedMessageList key={threadId} {...listProps} />;

  return (
    <MessageStreamShell
      t={t}
      scrollViewportRef={scrollViewportRef}
      contentStackRef={contentStackRef}
      scrollDownRef={scrollDownRef}
      scrollToBottom={scrollToBottom}
      promptPinSpacerHeight={promptPinSpacerHeight}
      overflowAnchor="none"
      list={list}
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
      completedAt={completedAt}
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

/** Dispatches to the virtual (default) or frozen viewer based on the setting. */
export function MessageStream(props: MessageStreamProps) {
  const threadViewer = useSettingsStore((s) => s.threadViewer);
  return threadViewer === 'frozen' ? (
    <FrozenMessageStream {...props} />
  ) : (
    <VirtualMessageStream {...props} />
  );
}
