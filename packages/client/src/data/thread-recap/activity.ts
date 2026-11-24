import type { Message, ToolCall } from '@funny/shared';

/**
 * The newest activity of a loaded thread payload (openspec `thread-recap`):
 * the id of its newest message (the recap's cache key and the runtime's upper
 * bound) and the time of the newest agent activity, an assistant or system
 * message or a tool call. The user's own messages are not activity to recap.
 * A loaded page that is not the newest one (`hasMoreAfter`) says nothing.
 */
export interface NewestActivity {
  newestMessageId: string | null;
  newestActivityAt: string | null;
}

type PayloadMessage = Pick<Message, 'id' | 'role' | 'timestamp'> & {
  toolCalls?: Pick<ToolCall, 'timestamp'>[];
};

const NONE: NewestActivity = { newestMessageId: null, newestActivityAt: null };

function later(a: string | null, b: string | undefined): string | null {
  if (!b) return a;
  if (!a) return b;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

export function newestActivity(
  messages: readonly PayloadMessage[] | undefined,
  hasMoreAfter?: boolean,
): NewestActivity {
  if (!messages?.length || hasMoreAfter) return NONE;
  let newestActivityAt: string | null = null;
  for (const message of messages) {
    if (message.role !== 'user') newestActivityAt = later(newestActivityAt, message.timestamp);
    for (const call of message.toolCalls ?? []) {
      newestActivityAt = later(newestActivityAt, call.timestamp ?? message.timestamp);
    }
  }
  return { newestMessageId: messages[messages.length - 1]!.id, newestActivityAt };
}
