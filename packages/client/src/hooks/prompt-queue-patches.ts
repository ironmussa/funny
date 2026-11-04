import type { QueuedMessage } from '@funny/shared';

import * as mutations from '@/stores/thread-mutations';
import type { ThreadState as ThreadStoreState } from '@/stores/thread-state';

/** Returns `map` with `key` set to `value`, or with `key` removed when `value` is undefined. */
function setOrOmit<V>(
  map: Record<string, V>,
  key: string,
  value: V | undefined,
): Record<string, V> {
  if (value !== undefined) return { ...map, [key]: value };
  const { [key]: _, ...rest } = map;
  return rest;
}

/** Builds a preview row from the queue summary while the full queue is loading. */
export function buildPreviewQueue(
  threadId: string | null | undefined,
  queuedCount: number,
  queuedNextMessage: string | undefined,
): QueuedMessage[] {
  if (!threadId || queuedCount <= 0 || !queuedNextMessage) return [];
  return [
    {
      id: `preview-queued-message:${threadId}`,
      threadId,
      content: queuedNextMessage,
      sortOrder: 0,
      createdAt: '',
    } satisfies QueuedMessage,
  ];
}

/** Local fetch result wins, then the persistent store cache, then the preview row. */
export function pickRenderedQueue(
  local: QueuedMessage[],
  cached: QueuedMessage[],
  preview: QueuedMessage[],
): QueuedMessage[] {
  if (local.length > 0) return local;
  if (cached.length > 0) return cached;
  return preview;
}

/** Store patch after a successful `listQueue` fetch. */
export function queueFetchedPatch(state: ThreadStoreState, tid: string, messages: QueuedMessage[]) {
  return {
    queuedMessagesByThread: setOrOmit(
      state.queuedMessagesByThread,
      tid,
      messages.length > 0 ? messages : undefined,
    ),
    queuedNextMessageByThread: setOrOmit(
      state.queuedNextMessageByThread,
      tid,
      messages[0]?.content || undefined,
    ),
  };
}

/** Store patch after a queued message was edited. */
export function queueEditedPatch(
  state: ThreadStoreState,
  tid: string,
  messageId: string,
  content: string,
) {
  const current = state.queuedMessagesByThread[tid] ?? [];
  const next = current.map((m) => (m.id === messageId ? { ...m, content } : m));
  return {
    queuedMessagesByThread: { ...state.queuedMessagesByThread, [tid]: next },
    queuedNextMessageByThread: next[0]?.content
      ? { ...state.queuedNextMessageByThread, [tid]: next[0].content }
      : state.queuedNextMessageByThread,
  };
}

/**
 * Store patch after a queued message was cancelled. Single write path: patch
 * the unified payload map (mirrors onto activeThread when this is the selected
 * thread) plus the persistent by-thread maps that survive thread switches.
 */
export function queueDeletedPatch(
  state: ThreadStoreState,
  tid: string,
  messageId: string,
  newCount: number,
) {
  const hasQueue = newCount > 0;
  const filtered = (state.queuedMessagesByThread[tid] ?? []).filter((m) => m.id !== messageId);
  const nextContent = hasQueue ? filtered[0]?.content || undefined : undefined;
  return {
    queuedCountByThread: setOrOmit(state.queuedCountByThread, tid, hasQueue ? newCount : undefined),
    queuedMessagesByThread: setOrOmit(
      state.queuedMessagesByThread,
      tid,
      hasQueue ? filtered : undefined,
    ),
    queuedNextMessageByThread: setOrOmit(state.queuedNextMessageByThread, tid, nextContent),
    ...mutations.applyThreadDataPatch(state, tid, (t) => ({
      ...t,
      queuedCount: newCount,
    })),
  };
}
