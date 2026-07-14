import { useContext } from 'react';

import { getItemKey, type RenderItem, type ToolItem } from '@/lib/render-items';

import { ToolCallCard } from '../ToolCallCard';
import { ToolCallGroup } from '../ToolCallGroup';
import { AuthorAvatar } from './AuthorAvatar';
import { ChangedFilesSummary } from './ChangedFilesSummary';
import { CompactionEventCard } from './CompactionEventCard';
import { FrozenViewerContext } from './frozen-message-context';
import { FrozenMessage } from './FrozenMessage';
import { GitEventCard } from './GitEventCard';
import type { MessageItem, VirtualRow } from './MemoizedMessageList.virtualRows';
import { MessageContent, CopyButton } from './MessageContent';
import { UserMessageCard } from './UserMessageCard';
import { WorkflowEventGroup } from './WorkflowEventGroup';

type ToolRendererCommonProps = {
  snapshotMap: Map<string, number>;
  isWaiting: boolean;
  onSend: (prompt: string, opts: { model: string; mode: string }) => void;
  onToolRespond?: (toolCallId: string, answer: string, toolName: string) => void;
};

type ToolItemRendererProps = ToolRendererCommonProps & {
  item: ToolItem;
};

export function ToolItemRenderer({
  item,
  snapshotMap,
  isWaiting,
  onSend,
  onToolRespond,
}: ToolItemRendererProps) {
  if (item.type === 'toolcall') {
    const tc = item.tc;
    return (
      <div
        data-tool-call-id={tc.id}
        {...(snapshotMap.has(tc.id) ? { 'data-todo-snapshot': snapshotMap.get(tc.id) } : {})}
      >
        <ToolCallCard
          name={tc.name}
          input={tc.input}
          output={tc.output}
          author={tc.author}
          timestamp={tc.timestamp}
          planText={tc['_planText']}
          childToolCalls={tc['_childToolCalls']}
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

  if (item.type === 'toolcall-group') {
    const groupSnapshotIdx =
      item.name === 'TodoWrite'
        ? Math.max(...item.calls.map((call: any) => snapshotMap.get(call.id) ?? -1))
        : -1;
    return (
      <div
        data-tool-call-id={item.calls[0].id}
        {...(groupSnapshotIdx >= 0 ? { 'data-todo-snapshot': groupSnapshotIdx } : {})}
      >
        <ToolCallGroup
          name={item.name}
          calls={item.calls}
          timestamp={item.calls[0]?.timestamp}
          renderCall={(call) => (
            <ToolCallCard
              key={call.id}
              name={item.name}
              input={call.input}
              output={call.output}
              author={call.author}
              childToolCalls={call['_childToolCalls']}
              hideLabel
              onRespond={
                (item.name === 'AskUserQuestion' || item.name === 'ExitPlanMode') &&
                isWaiting &&
                onToolRespond &&
                !call.output
                  ? (answer: string) => {
                      onToolRespond(call.id, answer, item.name);
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
}

type NonUserItemRendererProps = ToolRendererCommonProps & {
  item: RenderItem;
};

export function NonUserItemRenderer({
  item,
  snapshotMap,
  isWaiting,
  onSend,
  onToolRespond,
}: NonUserItemRendererProps) {
  const key = getItemKey(item);
  // In the frozen viewer, assistant markdown freezes to static HTML offscreen.
  const frozenViewer = useContext(FrozenViewerContext) !== null;

  if (item.type === 'message') {
    const msg = item.msg;
    // `contentVisibility:auto` was previously applied here for paint
    // virtualization. It broke a specific pattern: the server inserts
    // an empty assistant placeholder (content=''), Chrome remembers
    // the small rendered size, then the WS event updates the message
    // content (same msgId, content='...') and Chrome can skip repainting.
    return (
      <div data-item-key={key} className="group/msg relative w-full text-sm">
        <div
          data-testid={`assistant-message-${msg.id}`}
          className="px-3 py-1.5 text-sm leading-relaxed wrap-break-word"
        >
          <div className="flex items-start gap-2">
            {msg.author && <AuthorAvatar author={msg.author} />}
            <div className="min-w-0 flex-1">
              {frozenViewer ? (
                <FrozenMessage content={msg.content.trim()} />
              ) : (
                <MessageContent content={msg.content.trim()} />
              )}
            </div>
            <CopyButton content={msg.content} />
          </div>
        </div>
      </div>
    );
  }

  if (item.type === 'toolcall' || item.type === 'toolcall-group') {
    return (
      <div data-item-key={key}>
        <ToolItemRenderer
          item={item}
          snapshotMap={snapshotMap}
          isWaiting={isWaiting}
          onSend={onSend}
          onToolRespond={onToolRespond}
        />
      </div>
    );
  }

  if (item.type === 'toolcall-run') {
    return (
      <div data-item-key={key}>
        <div className="space-y-1">
          {item.items.map((toolItem) => (
            <ToolItemRenderer
              key={getItemKey(toolItem)}
              item={toolItem}
              snapshotMap={snapshotMap}
              isWaiting={isWaiting}
              onSend={onSend}
              onToolRespond={onToolRespond}
            />
          ))}
        </div>
      </div>
    );
  }

  if (item.type === 'workflow-event-group') {
    return (
      <div data-item-key={key}>
        <WorkflowEventGroup events={item.events} />
      </div>
    );
  }

  if (item.type === 'thread-event') {
    return (
      <div data-item-key={key}>
        <GitEventCard event={item.event} />
      </div>
    );
  }

  if (item.type === 'compaction-event') {
    return (
      <div data-item-key={key}>
        <CompactionEventCard event={item.event} />
      </div>
    );
  }

  return null;
}

type UserMessageRendererProps = {
  item: MessageItem;
  includeItemKey?: boolean;
  includeUserObserver?: boolean;
  onOpenLightbox: (images: { src: string; alt: string }[], index: number) => void;
  onFork?: (messageId: string) => void;
  onRewind?: (messageId: string) => void;
  onForkAndRewind?: (messageId: string) => void;
  forkingMessageId?: string | null;
  rewindDisabled?: boolean;
  rewindDisabledReason?: string;
  scrollToUserMessagePosition: (messageId: string) => void;
};

export function UserMessageRenderer({
  item,
  includeItemKey = true,
  includeUserObserver = true,
  onOpenLightbox,
  onFork,
  onRewind,
  onForkAndRewind,
  forkingMessageId,
  rewindDisabled,
  rewindDisabledReason,
  scrollToUserMessagePosition,
}: UserMessageRendererProps) {
  const msg = item.msg;
  return (
    <div
      className="relative pt-3 pb-3"
      {...(includeUserObserver ? { 'data-user-msg': msg.id } : {})}
      {...(includeItemKey ? { 'data-item-key': msg.id } : {})}
    >
      <UserMessageCard
        data-testid={`user-message-${msg.id}`}
        content={msg.content}
        images={msg.images}
        model={msg.model}
        permissionMode={msg.permissionMode}
        effort={msg.effort}
        timestamp={msg.timestamp}
        onClick={() => scrollToUserMessagePosition(msg.id)}
        onImageClick={onOpenLightbox}
        onFork={onFork ? () => onFork(msg.id) : undefined}
        onRewind={onRewind ? () => onRewind(msg.id) : undefined}
        onForkAndRewind={onForkAndRewind ? () => onForkAndRewind(msg.id) : undefined}
        forkDisabled={forkingMessageId != null}
        rewindDisabled={rewindDisabled}
        rewindDisabledReason={rewindDisabledReason}
      />
    </div>
  );
}

type VirtualRowContentProps = ToolRendererCommonProps &
  Omit<UserMessageRendererProps, 'item' | 'includeItemKey' | 'includeUserObserver'> & {
    row: VirtualRow;
    threadId: string;
    changeSummaryRunning?: boolean;
    onSessionReverted?: () => void;
  };

export function VirtualRowContent({
  row,
  threadId,
  changeSummaryRunning,
  onSessionReverted,
  snapshotMap,
  isWaiting,
  onSend,
  onToolRespond,
  onOpenLightbox,
  onFork,
  onRewind,
  onForkAndRewind,
  forkingMessageId,
  rewindDisabled,
  rewindDisabledReason,
  scrollToUserMessagePosition,
}: VirtualRowContentProps) {
  if (row.type === 'session-summary') {
    return (
      <div className="mt-3">
        <ChangedFilesSummary
          threadId={threadId}
          files={row.files}
          running={row.isLastSection && !!changeSummaryRunning}
          onReverted={onSessionReverted}
          fallbackDiffs={row.fallbackDiffs}
        />
      </div>
    );
  }

  const item = row.item;
  if (item.type === 'message' && item.msg.role === 'user') {
    return (
      <UserMessageRenderer
        item={item as MessageItem}
        onOpenLightbox={onOpenLightbox}
        onFork={onFork}
        onRewind={onRewind}
        onForkAndRewind={onForkAndRewind}
        forkingMessageId={forkingMessageId}
        rewindDisabled={rewindDisabled}
        rewindDisabledReason={rewindDisabledReason}
        scrollToUserMessagePosition={scrollToUserMessagePosition}
      />
    );
  }

  return (
    <NonUserItemRenderer
      item={item}
      snapshotMap={snapshotMap}
      isWaiting={isWaiting}
      onSend={onSend}
      onToolRespond={onToolRespond}
    />
  );
}
