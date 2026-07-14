import { useCallback, useImperativeHandle } from 'react';
import { useTranslation } from 'react-i18next';

import { useSettingsStore } from '@/stores/settings-store';

import { FrozenMessageStream } from './FrozenMessageStream';
import { MemoizedMessageList } from './MemoizedMessageList';
import { EMPTY_MESSAGES } from './MemoizedMessageList.constants';
import type { MessageStreamProps } from './message-stream-types';
import { MessageStreamShell } from './MessageStreamShell';
import { useMessageStreamScroll } from './use-message-stream-scroll';

export type { MessageStreamHandle, MessageStreamProps } from './message-stream-types';

const EMPTY_SNAPSHOT_MAP = new Map<string, number>();
const EMPTY_KNOWN_IDS = new Set<string>();

/**
 * Virtual viewer container: the TanStack Virtual `MemoizedMessageList` plus its
 * manual-anchoring scroll hook, rendered through the shared shell. This is the
 * default path and is behaviorally unchanged from before the shell extraction.
 */
function VirtualMessageStream(props: MessageStreamProps) {
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
  );

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

/** Dispatches to the virtual (default) or frozen viewer based on the setting. */
export function MessageStream(props: MessageStreamProps) {
  const threadViewer = useSettingsStore((s) => s.threadViewer);
  return threadViewer === 'frozen' ? (
    <FrozenMessageStream {...props} />
  ) : (
    <VirtualMessageStream {...props} />
  );
}
