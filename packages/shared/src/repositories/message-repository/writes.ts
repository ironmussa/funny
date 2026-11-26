/** Message writes: insert, edit, and truncate a thread after an anchor. */

import { eq, and, gt, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import type { RepoDeps } from '../deps.js';

/** New content for a message: the text alone, or the text with its images. */
type MessageUpdate = string | { content: string; images?: string | null };

function isTextOnly(update: MessageUpdate): update is string {
  return typeof update === 'string';
}

/** Insert a new message, returns the generated ID */
export async function insertMessage(
  deps: RepoDeps,
  data: {
    threadId: string;
    role: string;
    content: string;
    images?: string | null;
    model?: string | null;
    permissionMode?: string | null;
    effort?: string | null;
    author?: string | null;
    timestamp?: string | null;
  },
): Promise<string> {
  const { db, schema, dbRun } = deps;
  const id = nanoid();
  await dbRun(
    db.insert(schema.messages).values({
      id,
      threadId: data.threadId,
      role: data.role,
      content: data.content,
      images: data.images ?? null,
      model: data.model ?? null,
      permissionMode: data.permissionMode ?? null,
      effort: data.effort ?? null,
      author: data.author ?? null,
      timestamp: data.timestamp ?? new Date().toISOString(),
    }),
  );
  return id;
}

/** Update message content (and optionally images) */
export async function updateMessage(
  deps: RepoDeps,
  id: string,
  data: string | { content: string; images?: string | null },
): Promise<void> {
  const { db, schema, dbRun } = deps;
  const updates = isTextOnly(data)
    ? { content: data, timestamp: new Date().toISOString() }
    : {
        content: data.content,
        images: data.images ?? null,
        timestamp: new Date().toISOString(),
      };
  await dbRun(db.update(schema.messages).set(updates).where(eq(schema.messages.id, id)));
}

/**
 * Delete all messages in a thread whose timestamp is strictly after the
 * given anchor message's timestamp. Tool calls cascade via FK.
 * Used by "Rewind code to here" to truncate the conversation.
 */
export async function deleteMessagesAfter(
  deps: RepoDeps,
  threadId: string,
  anchorMessageId: string,
): Promise<number> {
  const { db, schema, dbAll, dbGet, dbRun } = deps;
  const anchor = await dbGet(
    db
      .select({ timestamp: schema.messages.timestamp })
      .from(schema.messages)
      .where(and(eq(schema.messages.threadId, threadId), eq(schema.messages.id, anchorMessageId))),
  );
  if (!anchor) return 0;

  const toDelete = await dbAll(
    db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.threadId, threadId),
          gt(schema.messages.timestamp, anchor.timestamp),
        ),
      ),
  );
  if (toDelete.length === 0) return 0;
  await dbRun(
    db.delete(schema.messages).where(
      inArray(
        schema.messages.id,
        toDelete.map((r) => r.id),
      ),
    ),
  );
  return toDelete.length;
}
