/**
 * Row-level reads shared by the message repository's queries: tool calls of
 * a set of messages, message counts, and the user message that opens a
 * section.
 */

import { eq, and, lt, lte, desc, inArray, sql } from 'drizzle-orm';

import type { RepoDeps } from '../deps.js';

export type MessageRow = RepoDeps['schema']['messages']['$inferSelect'];
export type ToolCallRow = RepoDeps['schema']['toolCalls']['$inferSelect'];

/** Tool calls of the given messages, in one query (none for no ids). */
export async function fetchToolCallsForMessages(
  deps: RepoDeps,
  messageIds: string[],
): Promise<ToolCallRow[]> {
  const { db, schema, dbAll } = deps;
  if (messageIds.length === 0) return [];
  return dbAll(
    db
      .select()
      .from(schema.toolCalls)
      .where(
        messageIds.length === 1
          ? eq(schema.toolCalls.messageId, messageIds[0])
          : inArray(schema.toolCalls.messageId, messageIds),
      ),
  );
}

/** Enrich raw message rows with parsed images and their tool calls */
export async function enrichMessages(
  deps: RepoDeps,
  messages: MessageRow[],
  allToolCalls?: ToolCallRow[],
) {
  const toolCalls =
    allToolCalls ??
    (await fetchToolCallsForMessages(
      deps,
      messages.map((m) => m.id),
    ));

  // Group once instead of filtering every tool call per message (O(m × t)
  // on long threads). Insertion order keeps each message's calls in order.
  const toolCallsByMessage = new Map<string, typeof toolCalls>();
  for (const tc of toolCalls) {
    const group = toolCallsByMessage.get(tc.messageId);
    if (group) group.push(tc);
    else toolCallsByMessage.set(tc.messageId, [tc]);
  }
  return messages.map((msg) => ({
    ...msg,
    images: msg.images ? JSON.parse(msg.images) : undefined,
    toolCalls: toolCallsByMessage.get(msg.id) ?? [],
  }));
}

export type EnrichedMessage = Awaited<ReturnType<typeof enrichMessages>>[number];

/** Count all messages belonging to a thread. Cheap COUNT(*) over the
 *  threadId index, used for paginated-window metadata. */
export async function countThreadMessages(deps: RepoDeps, threadId: string): Promise<number> {
  const { db, schema, dbGet } = deps;
  const row = await dbGet(
    db
      .select({ count: sql<number>`count(*)` })
      .from(schema.messages)
      .where(eq(schema.messages.threadId, threadId)),
  );
  return Number(row?.count ?? 0);
}

export async function countMessagesBefore(
  deps: RepoDeps,
  threadId: string,
  timestamp: string,
): Promise<number> {
  const { db, schema, dbGet } = deps;
  const row = await dbGet(
    db
      .select({ count: sql<number>`count(*)` })
      .from(schema.messages)
      .where(and(eq(schema.messages.threadId, threadId), lt(schema.messages.timestamp, timestamp))),
  );
  return Number(row?.count ?? 0);
}

export async function findLeadingUserMessage(
  deps: RepoDeps,
  threadId: string,
  firstMessage: MessageRow,
): Promise<MessageRow | undefined> {
  if (firstMessage.role === 'user') {
    return undefined;
  }

  const { db, schema, dbGet } = deps;
  const sectionUser = await dbGet(
    db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.threadId, threadId),
          eq(schema.messages.role, 'user'),
          lte(schema.messages.timestamp, firstMessage.timestamp),
        ),
      )
      .orderBy(desc(schema.messages.timestamp))
      .limit(1),
  );

  return sectionUser ?? undefined;
}
