/** Virtualized transcript of the selected thread. */

import type { ThreadWorkspaceData } from '@funny/client-core';
import { ConversationRow } from '@funny/gpuix-ui/conversation';
import { scrollbarStyle } from '@funny/gpuix-ui/theme';
import { ScrollableVirtualList } from '@funny/gpuix-ui/virtual-list-scrollbar';
import {
  clampWindowStart,
  maximumWindowStart,
  shiftedWindowStartForItems,
  windowStartForVisibleRange,
} from '@funny/gpuix-ui/virtual-range';
import type { EventPayload } from '@gpuix/react';
import { memo, useCallback, useMemo, useState } from 'react';

import type { NativeApplicationServices } from '../application';
import type { ThreadRenderItem } from '../thread-render-items';
import { NativeButton, useNativeColors } from './hooks';
import { MessageRow, ToolCallBlock } from './message-row';

export const THREAD_RETAINED_WINDOW_SIZE = 48;
const THREAD_WINDOW_BUFFER = 12;

type ThreadTranscriptItem =
  | ThreadRenderItem
  | {
      id: 'load-older';
      key: 'load-older';
      kind: 'load-older';
    };

const LOAD_OLDER_ITEM: ThreadTranscriptItem = {
  id: 'load-older',
  key: 'load-older',
  kind: 'load-older',
};

export const ThreadTranscript = memo(function ThreadTranscript({
  application,
  data,
  onHistoryList,
  renderItems,
  richContent,
  threadId,
}: {
  application: NativeApplicationServices;
  data: ThreadWorkspaceData;
  onHistoryList?: (id: number | null) => void;
  renderItems: readonly ThreadRenderItem[];
  richContent: boolean;
  threadId: string;
}) {
  const colors = useNativeColors();
  const items = useMemo<ThreadTranscriptItem[]>(
    () => (data.hasMore ? [LOAD_OLDER_ITEM, ...renderItems] : [...renderItems]),
    [data.hasMore, renderItems],
  );
  // followsTail lives in state, next to the retained range it moves: render reads it.
  const [retainedState, setRetainedState] = useState(() => ({
    items,
    start: maximumWindowStart(items.length, THREAD_RETAINED_WINDOW_SIZE),
    followsTail: true,
  }));
  let currentRetainedState = retainedState;
  if (retainedState.items !== items) {
    const shiftedStart = shiftedWindowStartForItems(
      retainedState.start,
      retainedState.items,
      items,
    );
    currentRetainedState = {
      items,
      followsTail: retainedState.followsTail,
      start: retainedState.followsTail
        ? maximumWindowStart(items.length, THREAD_RETAINED_WINDOW_SIZE)
        : clampWindowStart(shiftedStart, items.length, THREAD_RETAINED_WINDOW_SIZE),
    };
    setRetainedState(currentRetainedState);
  }
  const effectiveWindowStart = currentRetainedState.followsTail
    ? maximumWindowStart(items.length, THREAD_RETAINED_WINDOW_SIZE)
    : clampWindowStart(currentRetainedState.start, items.length, THREAD_RETAINED_WINDOW_SIZE);
  const retainedItems = items.slice(
    effectiveWindowStart,
    effectiveWindowStart + THREAD_RETAINED_WINDOW_SIZE,
  );
  const updateRetainedWindow = useCallback(
    (event: EventPayload) => {
      const visibleStart = Math.max(0, Math.floor(event.startIndex ?? 0));
      const visibleEnd = Math.max(visibleStart + 1, Math.ceil(event.endIndex ?? visibleStart + 1));
      setRetainedState((current) => ({
        items,
        followsTail: visibleEnd >= items.length - 1,
        start: windowStartForVisibleRange({
          currentStart: current.items === items ? current.start : effectiveWindowStart,
          itemCount: items.length,
          windowSize: THREAD_RETAINED_WINDOW_SIZE,
          buffer: THREAD_WINDOW_BUFFER,
          visibleStart,
          visibleEnd,
        }),
      }));
    },
    [effectiveWindowStart, items],
  );

  return (
    <ScrollableVirtualList
      onListId={onHistoryList}
      scrollbarTestId="conversation-scrollbar"
      alignment="bottom"
      followTail
      itemCount={items.length}
      windowStart={effectiveWindowStart}
      onVisibleRange={updateRetainedWindow}
      overdraw={360}
      estimatedItemHeight={220}
      role="log"
      aria-label="Conversation"
      style={{
        flexGrow: 1,
        minHeight: 0,
        width: '100%',
        backgroundColor: colors.background,
        ...scrollbarStyle(colors),
      }}
    >
      {retainedItems.map((item) => {
        if (item.kind === 'load-older') {
          return (
            <ConversationRow key={item.key}>
              <NativeButton
                variant="ghost"
                size="small"
                onPress={() => {
                  void application.data.loadOlder(threadId);
                }}
                disabled={data.loading}
              >
                <text>{data.loading ? 'Loading…' : 'Load older messages'}</text>
              </NativeButton>
            </ConversationRow>
          );
        }
        if (item.kind === 'message') {
          return (
            <MessageRow
              key={item.key}
              message={data.messagesById[item.id]}
              messageId={item.id}
              richContent={richContent}
            />
          );
        }
        const toolCall = data.toolCallsById[item.id];
        return toolCall ? (
          <ToolCallBlock key={item.key} richContent={richContent} toolCall={toolCall} />
        ) : null;
      })}
    </ScrollableVirtualList>
  );
});
