import type { ThreadEvent } from '@funny/shared';
import { useContext, useMemo } from 'react';

import { getItemKey, type RenderItem, type ToolItem } from '@/lib/render-items';
import { useThreadById } from '@/lib/thread-selectors';
import { turnOutcomesFromEvents } from '@/lib/turn-outcomes-from-events';
import { useThreadStore } from '@/stores/thread-store';

import { ToolCallCard } from '../ToolCallCard';
import { ToolCallGroup } from '../ToolCallGroup';
import { AgentResultCard } from './AgentStatusCards';
import { AuthorAvatar } from './AuthorAvatar';
import { ChangedFilesSummary } from './ChangedFilesSummary';
import { CompactionEventCard } from './CompactionEventCard';
import { FrozenViewerContext } from './frozen-message-context';
import { FrozenMessage } from './FrozenMessage';
import { GitEventCard } from './GitEventCard';
import type { MessageItem, VirtualRow } from './MemoizedMessageList.virtualRows';
import { MessageContent, CopyButton } from './MessageContent';
import { SandboxErrorCard } from './SandboxErrorCard';
import { UserMessageCard } from './UserMessageCard';
import { WorkflowEventGroup } from './WorkflowEventGroup';

type ToolRendererCommonProps = {
  snapshotMap: Map<string, number>;
  isWaiting: boolean;
  onSend: (prompt: string, opts: { model: string; mode: string; effort?: string }) => void;
  onToolRespond?: (toolCallId: string, answer: string, toolName: string) => void;
};

type ToolItemRendererProps = ToolRendererCommonProps & {
  item: ToolItem;
};

function ToolItemRenderer({
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
              timestamp={call.timestamp}
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

type ThreadEventRenderItem = Extract<RenderItem, { type: 'thread-event' }>;

function ThreadEventItem({ event }: { event: ThreadEventRenderItem['event'] }) {
  if (event.type === 'turn_outcome') return <StoppedOutcomeRow event={event} />;
  if (event.type === 'sandbox:error') return <SandboxErrorCard event={event} />;
  return <GitEventCard event={event} />;
}

type NonUserItemRendererProps = ToolRendererCommonProps & {
  item: RenderItem;
};

function NonUserItemRenderer({
  item,
  snapshotMap,
  isWaiting,
  onSend,
  onToolRespond,
}: NonUserItemRendererProps) {
  const key = getItemKey(item);
  if (item.type === 'message') return <AssistantMessageItem item={item} />;

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
        <ThreadEventItem event={item.event} />
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
      className="relative pb-3"
      {...(includeUserObserver ? { 'data-user-msg': msg.id } : {})}
      {...(includeItemKey ? { 'data-item-key': msg.id } : {})}
    >
      <UserMessageCard
        data-testid={`user-message-${msg.id}`}
        content={msg.content}
        automatic={msg.author === 'Claude Code'}
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

/**
 * Inline record of a stop, placed where it happened in the timeline. Hidden
 * only while it is the thread's latest outcome and the thread is still
 * stopped — the status tail's stopped card (with Continue) shows it then.
 */
function StoppedOutcomeRow({ event }: { event: ThreadEvent }) {
  // Status comes from the thread row: the payload's copy is a load-time
  // snapshot and stays `running` after a live stop, which doubled the card.
  const isStopped = useThreadById(event.threadId)?.status === 'stopped';
  const isLatestOutcome = useThreadStore(
    (s) =>
      s.threadDataById[event.threadId]?.threadEvents?.findLast((e) => e.type === 'turn_outcome')
        ?.id === event.id,
  );
  if (isStopped && isLatestOutcome) return null;
  let completedAt: string | undefined;
  try {
    completedAt = JSON.parse(event.data as string)?.completedAt;
  } catch {
    completedAt = undefined;
  }
  return (
    <div className="flow-root">
      <div className="-mt-3">
        <AgentResultCard
          status="stopped"
          cost={0}
          duration={0}
          completedAt={completedAt ?? event.createdAt}
        />
      </div>
    </div>
  );
}

/**
 * End-of-turn bar. The persisted `turn_outcome` event says how the run ended;
 * older turns without one are shown as completed. Completed bars reveal on
 * hover; stopped/failed ones stay visible so the outcome is never lost.
 */
function TurnEndBar({
  row,
  threadId,
}: {
  row: Extract<VirtualRow, { type: 'turn-end' }>;
  threadId: string;
}) {
  // Keyed by threadId (not ThreadProvider) so every host of the list works.
  const threadEvents = useThreadStore((s) => s.threadDataById[threadId]?.threadEvents);
  const outcome = useMemo(() => turnOutcomesFromEvents(threadEvents), [threadEvents]).get(
    row.userItem.msg.id,
  );
  // A turn that ended stopped already shows its inline stop row.
  if (outcome?.status === 'stopped') return null;

  return (
    // flow-root keeps the negative margin inside the row: the bar is pulled up
    // into the uniform virtual-row gap so it hugs the answer it closes, and the
    // measured row height shrinks by the same amount.
    <div className="flow-root" data-testid={`turn-end-${row.userItem.msg.id}`}>
      <div className="-mt-3">
        <AgentResultCard
          status={outcome?.status ?? 'completed'}
          cost={0}
          duration={0}
          startedAt={row.startedAt}
          completedAt={outcome?.completedAt ?? row.completedAt}
          copyThreadId={threadId}
          copyMessages={row.messages}
          revealForSection={row.userItem.msg.id}
        />
      </div>
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

  if (row.type === 'turn-end') {
    return <TurnEndBar row={row} threadId={threadId} />;
  }

  const item = row.item;
  if (isUserMessageItem(item)) {
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

function AssistantMessageItem({ item }: { item: MessageItem }) {
  const frozenViewer = useContext(FrozenViewerContext) !== null;
  const msg = item.msg;
  // `contentVisibility:auto` was previously applied here for paint
  // virtualization. It broke a specific pattern: the server inserts
  // an empty assistant placeholder (content=''), Chrome remembers
  // the small rendered size, then the WS event updates the message
  // content (same msgId, content='...') and Chrome can skip repainting.
  return (
    <div data-item-key={getItemKey(item)} className="group/msg relative w-full text-sm">
      <div
        data-testid={`assistant-message-${msg.id}`}
        className="px-3 py-1.5 text-sm leading-relaxed wrap-break-word"
      >
        <div className="flex items-start gap-2">
          {/* Imported Claude Code transcripts once tagged replies with a synthetic author. */}
          {msg.author && msg.author !== 'Claude Code' && <AuthorAvatar author={msg.author} />}
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

function isUserMessageItem(item: RenderItem): item is MessageItem {
  return item.type === 'message' && item.msg.role === 'user';
}
