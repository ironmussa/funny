import { type RefObject, useCallback, useImperativeHandle, useMemo } from 'react';

import { clipEventsToMessageWindow } from '@/lib/render-items';

import { EMPTY_MESSAGES } from './MemoizedMessageList.constants';
import type {
  MemoizedMessageListHandle,
  MemoizedMessageListProps,
} from './MemoizedMessageList.types';
import type { MessageStreamProps } from './message-stream-types';

const EMPTY_SNAPSHOT_MAP = new Map<string, number>();
const EMPTY_KNOWN_IDS = new Set<string>();

const noopLightbox = (_images: { src: string; alt: string }[], _index: number) => {};

interface StreamScrollRefs {
  messageListRef: RefObject<MemoizedMessageListHandle | null>;
  scrollViewportRef: RefObject<HTMLDivElement | null>;
  scrollToBottom: () => void;
}

/**
 * The part of a message stream shared by the virtual and frozen viewers: the
 * imperative handle, the permission-prompt handlers, and the props of the
 * message list. Each stream only adds its scroll hook and its list component.
 */
export function useMessageStreamList(props: MessageStreamProps, scroll: StreamScrollRefs) {
  const {
    ref,
    threadId,
    status,
    messages,
    leadingUserMessage,
    threadEvents,
    compactionEvents,
    pagination,
    pendingPermission,
    onPermissionApproval,
    snapshotMap = EMPTY_SNAPSHOT_MAP,
    knownIds = EMPTY_KNOWN_IDS,
    onOpenLightbox,
  } = props;
  const { messageListRef, scrollViewportRef, scrollToBottom } = scroll;

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

  const respondToPermission = useCallback(
    (approved: boolean, alwaysAllow?: boolean) => {
      if (!pendingPermission || !onPermissionApproval) return;
      if (alwaysAllow) onPermissionApproval(pendingPermission.toolName, approved, true);
      else onPermissionApproval(pendingPermission.toolName, approved);
    },
    [pendingPermission, onPermissionApproval],
  );
  const handlePermissionApprove = useCallback(
    () => respondToPermission(true),
    [respondToPermission],
  );
  const handlePermissionAlwaysAllow = useCallback(
    () => respondToPermission(true, true),
    [respondToPermission],
  );
  const handlePermissionDeny = useCallback(() => respondToPermission(false), [respondToPermission]);

  // Events load in full while messages are paged: hide the ones outside the
  // loaded page until the messages around them load.
  const listMessages = messages ?? EMPTY_MESSAGES;
  const hasOlder = pagination?.hasMore;
  const hasNewer = pagination?.hasMoreAfter;
  const windowed = useMemo(
    () =>
      clipEventsToMessageWindow(listMessages, threadEvents, compactionEvents, {
        hasOlder,
        hasNewer,
      }),
    [listMessages, threadEvents, compactionEvents, hasOlder, hasNewer],
  );

  const listProps: MemoizedMessageListProps = {
    ref: messageListRef,
    messages: listMessages,
    leadingUserMessage,
    threadEvents: windowed.threadEvents,
    compactionEvents: windowed.compactionEvents,
    threadId,
    threadStatus: status,
    knownIds,
    snapshotMap,
    onSend: props.onSend,
    onOpenLightbox: onOpenLightbox ?? noopLightbox,
    onToolRespond: props.onToolRespond,
    onFork: props.onFork,
    onRewind: props.onRewind,
    onForkAndRewind: props.onForkAndRewind,
    forkingMessageId: props.forkingMessageId,
    rewindDisabled: props.rewindDisabled,
    rewindDisabledReason: props.rewindDisabledReason,
    scrollRef: scrollViewportRef,
    sessionChanges: props.sessionChanges,
    changeSummaryRunning: status === 'running',
    onSessionReverted: props.onSessionReverted,
  };

  return { listProps, handlePermissionApprove, handlePermissionAlwaysAllow, handlePermissionDeny };
}
