/**
 * Pure message-list helpers for the thread store: reconciling optimistic
 * echoes with their persisted copies, merging a resync window and folding a
 * fetched page into the loaded payload. No store access, no side effects.
 */
import type { Message } from '@funny/shared';

import type { ThreadWithMessages } from './thread-types';

export type LocalMessage = Message & { toolCalls?: any[] };

const DEQUEUED_MESSAGE_ID_PREFIX = 'dequeued-';

/** Id prefix for user bubbles appended locally by `appendOptimisticMessage`.
 *  The persisted copy of the same message arrives later under a server id, so
 *  merge/pagination must reconcile the two by content — the prefix is what
 *  tells them a local message is a reconcilable echo rather than history. */
export const OPTIMISTIC_MESSAGE_ID_PREFIX = 'optimistic-';

/** True for local-only user messages (optimistic bubble or dequeued echo)
 *  that a server-persisted copy with the same content should supersede. */
function isLocalEchoUserMessage(m: Pick<LocalMessage, 'id' | 'role'>): boolean {
  return (
    m.role === 'user' &&
    (m.id.startsWith(OPTIMISTIC_MESSAGE_ID_PREFIX) || m.id.startsWith(DEQUEUED_MESSAGE_ID_PREFIX))
  );
}

function userMessageDedupKey(message: Pick<LocalMessage, 'role' | 'content' | 'images'>): string {
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

/** Prepend an older page, dropping ids already loaded (overlapping timestamps).
 *  Returns the merged messages, how many were new, and the leading user
 *  message to keep (cleared when it is now part of the loaded window). */
export function prependOlderMessages(
  t: ThreadWithMessages,
  olderMessages: LocalMessage[],
  leadingUserMessage: LocalMessage | undefined,
) {
  const existingIds = new Set(t.messages.map((m) => m.id));
  const newMessages = olderMessages.filter((m) => !existingIds.has(m.id));
  const messages = [...newMessages, ...t.messages];
  const leadingUserAlreadyLoaded =
    leadingUserMessage != null && messages.some((m) => m.id === leadingUserMessage.id);
  return {
    messages,
    added: newMessages.length,
    leadingUserMessage: leadingUserAlreadyLoaded ? undefined : leadingUserMessage,
  };
}

/** Append a newer page. A just-sent follow-up lives locally as an optimistic
 *  bubble whose random id never matches the persisted row, and the persisted
 *  copy is always newer than the bubble's timestamp — so it lands in this
 *  'after' page. Reconcile it onto the bubble (adopting the server id)
 *  instead of appending a second identical user card. */
export function appendNewerMessages(t: ThreadWithMessages, newerMessages: LocalMessage[]) {
  const existingIds = new Set(t.messages.map((m) => m.id));
  let baseMessages = t.messages;
  let lastUserMessage = t.lastUserMessage;
  const appended: LocalMessage[] = [];
  for (const m of newerMessages) {
    if (existingIds.has(m.id)) continue;
    const echoIdx =
      m.role === 'user'
        ? baseMessages.findIndex(
            (lm) =>
              isLocalEchoUserMessage(lm) && userMessageDedupKey(lm) === userMessageDedupKey(m),
          )
        : -1;
    if (echoIdx >= 0) {
      const reconciled = { ...baseMessages[echoIdx], ...m };
      const echoId = baseMessages[echoIdx].id;
      baseMessages = baseMessages.map((lm, i) => (i === echoIdx ? reconciled : lm));
      if (lastUserMessage?.id === echoId) lastUserMessage = reconciled;
      continue;
    }
    appended.push(m);
  }
  return { messages: [...baseMessages, ...appended], lastUserMessage };
}

/** Drop the last user message (a failed send) and point `lastUserMessage`
 *  back at the previous one. */
export function dropLastUserMessage(t: ThreadWithMessages): ThreadWithMessages {
  let lastUserIdx = -1;
  for (let i = t.messages.length - 1; i >= 0; i--) {
    if (t.messages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return t;
  const nextMessages = t.messages.filter((_, i) => i !== lastUserIdx);
  const prevUserMsg = [...nextMessages].reverse().find((m) => m.role === 'user');
  return {
    ...t,
    messages: nextMessages,
    lastUserMessage: prevUserMsg ?? t.lastUserMessage,
  };
}
