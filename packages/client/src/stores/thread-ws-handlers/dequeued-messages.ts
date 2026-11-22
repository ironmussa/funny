/**
 * User messages taken off a thread's follow-up queue (`queue_update` with a
 * `dequeuedMessage`), held until the next agent message so they appear right
 * before the response they started.
 */

import type { ImageAttachment, MessageRole } from '@funny/shared';

// Buffer for dequeued user messages — injected when the next agent:message
// arrives so the user message appears right before the new agent's response.
// We use handleWSMessage (called synchronously during flush) rather than
// handleWSInit (deferred via startTransition) to guarantee correct ordering.
interface DequeuedMessageBuffer {
  content: string;
  images?: ImageAttachment[];
}
export const pendingDequeuedMessages = new Map<string, DequeuedMessageBuffer>();
const DEQUEUED_MESSAGE_ID_PREFIX = 'dequeued-';

function isAssistantScaffold(message: { role: string; content: string; toolCalls?: unknown[] }) {
  return message.role === 'assistant' && (!message.content || (message.toolCalls?.length ?? 0) > 0);
}

export function hasAssistantContentAfterLastUser(
  messages: Array<{ role: string; content?: string }>,
) {
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user');
  return messages
    .slice(lastUserIndex + 1)
    .some((message) => message.role === 'assistant' && !!message.content?.trim());
}

export function resultTextToAssistantMessage(data: any): string | null {
  if (typeof data?.result !== 'string') return null;
  const result = data.result.trim();
  return result.length > 0 ? result : null;
}

/**
 * True when the user-message run immediately before `insertionIndex` already
 * contains the buffer entry. This covers both normal appends and the case where
 * a refreshed assistant message already exists after the real dequeued user
 * message.
 */
function userRunBeforeHasMessage(
  messages: Array<{ role: string; content: string }>,
  content: string,
  insertionIndex: number = messages.length,
): boolean {
  for (let i = insertionIndex - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') return false;
    if (m.content === content) return true;
  }
  return false;
}

/**
 * True when the dequeued user card is already represented in the visible turn.
 * Unlike `userRunBeforeHasMessage`, this also tolerates trailing assistant
 * scaffolding (empty assistant rows / tool-call parents). Those rows are often
 * inserted before the queued-message buffer arrives, and render-items may hide
 * the empty assistant row, making a later synthetic append look like two user
 * follow-ups in a row.
 */
export function dequeuedUserAlreadyShownInTurn(
  messages: Array<{ role: string; content: string; toolCalls?: unknown[] }>,
  content: string,
  insertionIndex: number = messages.length,
): boolean {
  if (userRunBeforeHasMessage(messages, content, insertionIndex)) return true;

  let beforeAgentScaffold = insertionIndex;
  while (beforeAgentScaffold > 0 && isAssistantScaffold(messages[beforeAgentScaffold - 1])) {
    beforeAgentScaffold -= 1;
  }
  if (beforeAgentScaffold === insertionIndex) return false;
  return userRunBeforeHasMessage(messages, content, beforeAgentScaffold);
}

export function trailingAssistantScaffoldStart(
  messages: Array<{ role: string; content: string; toolCalls?: unknown[] }>,
): number {
  let index = messages.length;
  while (index > 0 && isAssistantScaffold(messages[index - 1])) {
    index -= 1;
  }
  return index;
}

export function buildDequeuedUserMessage(
  threadId: string,
  dequeuedMsg: DequeuedMessageBuffer,
): {
  id: string;
  threadId: string;
  role: MessageRole;
  content: string;
  images?: ImageAttachment[];
  timestamp: string;
} {
  return {
    id: `${DEQUEUED_MESSAGE_ID_PREFIX}${crypto.randomUUID()}`,
    threadId,
    role: 'user' as MessageRole,
    content: dequeuedMsg.content,
    images: dequeuedMsg.images,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Pull the buffered dequeued user message (if any) for `threadId` and turn it
 * into the synthetic user-card row to splice in BEFORE the agent's first output
 * of the turn. Always clears the buffer when called — even when injection is
 * skipped — so a stale entry can't leak into a later turn.
 *
 * Called from BOTH handleWSMessage (assistant text) and handleWSToolCall;
 * whichever lands first wins. A queued follow-up frequently starts its turn
 * with a tool call rather than assistant text, so gating injection only on
 * assistant messages left the user card invisible for the entire tool phase of
 * the turn — and missing on refresh-less surfaces until the first text landed.
 *
 * Returns [] when nothing is buffered or the user-message run immediately
 * before the insertion point already shows the same content.
 */
export function takeDequeuedUserMessages(
  threadId: string,
  messages: Array<{ role: string; content: string }>,
  insertionIndex: number = messages.length,
): Array<{
  id: string;
  threadId: string;
  role: MessageRole;
  content: string;
  images?: ImageAttachment[];
  timestamp: string;
}> {
  const dequeuedMsg = pendingDequeuedMessages.get(threadId);
  if (!dequeuedMsg) return [];
  pendingDequeuedMessages.delete(threadId);
  if (dequeuedUserAlreadyShownInTurn(messages, dequeuedMsg.content, insertionIndex)) return [];
  return [buildDequeuedUserMessage(threadId, dequeuedMsg)];
}
