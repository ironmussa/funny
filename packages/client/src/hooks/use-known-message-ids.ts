import { useState } from 'react';

interface KnownMessage {
  id: string;
  toolCalls?: ReadonlyArray<{ id: string }> | null;
}

function collectIds(messages: ReadonlyArray<KnownMessage> | null | undefined): Set<string> {
  const ids = new Set<string>();
  for (const message of messages ?? []) {
    ids.add(message.id);
    for (const toolCall of message.toolCalls ?? []) ids.add(toolCall.id);
  }
  return ids;
}

/**
 * The message and tool-call ids present when `threadId` became active. Items
 * that arrive later stay out of the set, so the stream can animate their
 * entrance. The snapshot is retaken only when the thread changes.
 */
export function useKnownMessageIds(
  threadId: string | undefined,
  messages: ReadonlyArray<KnownMessage> | null | undefined,
): Set<string> {
  const [snapshot, setSnapshot] = useState(() => ({ threadId, ids: collectIds(messages) }));
  if (snapshot.threadId === threadId) return snapshot.ids;
  const next = { threadId, ids: collectIds(messages) };
  setSnapshot(next);
  return next.ids;
}
