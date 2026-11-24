/**
 * Reconciling locally held thread messages with the server's copies: the
 * optimistic / dequeued echoes a send leaves behind, and the fresh window a
 * resync brings back.
 */

import type { Message } from '@funny/shared';

export type LocalMessage = Message & { toolCalls?: any[] };

const DEQUEUED_MESSAGE_ID_PREFIX = 'dequeued-';

/** Id prefix for user bubbles appended locally by `appendOptimisticMessage`.
 *  The persisted copy of the same message arrives later under a server id, so
 *  merge/pagination must reconcile the two by content — the prefix is what
 *  tells them a local message is a reconcilable echo rather than history. */
export const OPTIMISTIC_MESSAGE_ID_PREFIX = 'optimistic-';

/** True for local-only user messages (optimistic bubble or dequeued echo)
 *  that a server-persisted copy with the same content should supersede. */
export function isLocalEchoUserMessage(m: Pick<LocalMessage, 'id' | 'role'>): boolean {
  return (
    m.role === 'user' &&
    (m.id.startsWith(OPTIMISTIC_MESSAGE_ID_PREFIX) || m.id.startsWith(DEQUEUED_MESSAGE_ID_PREFIX))
  );
}

export function userMessageDedupKey(
  message: Pick<LocalMessage, 'role' | 'content' | 'images'>,
): string {
  return message.role === 'user'
    ? `${message.content}\u0000${JSON.stringify(message.images ?? [])}`
    : '';
}

/** Merge fresh server messages into the local cache.
 *  Fresh messages are the source of truth for their timestamp window — they
 *  replace local copies by ID and recover anything missed while the WS was
 *  disconnected. Older paginated messages and locally-newer optimistic
 *  messages are preserved. */
export function mergeMessagesById(local: LocalMessage[], fresh: LocalMessage[]): LocalMessage[] {
  if (fresh.length === 0) return local;

  const freshTimes = fresh.map((m) => new Date(m.timestamp).getTime());
  const oldest = Math.min(...freshTimes);
  const newest = Math.max(...freshTimes);
  const freshIds = new Set(fresh.map((m) => m.id));
  const freshUserKeys = new Set(
    fresh.flatMap((message) => (message.role === 'user' ? [userMessageDedupKey(message)] : [])),
  );

  const before: LocalMessage[] = [];
  const after: LocalMessage[] = [];
  for (const m of local) {
    if (freshIds.has(m.id)) continue;
    if (isLocalEchoUserMessage(m) && freshUserKeys.has(userMessageDedupKey(m))) {
      continue;
    }
    const t = new Date(m.timestamp).getTime();
    if (t < oldest) before.push(m);
    else if (t > newest) after.push(m);
    // Within the fresh window but not in fresh — likely an optimistic
    // duplicate the server has since superseded; drop it.
  }
  return [...before, ...fresh, ...after];
}
