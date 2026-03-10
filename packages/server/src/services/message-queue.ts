/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain depends: Database
 */

import { eq, asc } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db, dbAll, dbGet, dbRun, schema } from '../db/index.js';
import { log } from '../lib/logger.js';

export interface QueueEntry {
  id: string;
  threadId: string;
  content: string;
  provider: string | null;
  model: string | null;
  permissionMode: string | null;
  images: string | null;
  allowedTools: string | null;
  disallowedTools: string | null;
  fileReferences: string | null;
  sortOrder: number;
  createdAt: string;
}

/** Add a message to the queue for a thread. */
export async function enqueue(
  threadId: string,
  entry: {
    content: string;
    provider?: string;
    model?: string;
    permissionMode?: string;
    images?: string;
    allowedTools?: string;
    disallowedTools?: string;
    fileReferences?: string;
  },
): Promise<QueueEntry> {
  const existing = await dbAll(
    db.select().from(schema.messageQueue).where(eq(schema.messageQueue.threadId, threadId)),
  );
  const maxOrder = existing.length > 0 ? Math.max(...existing.map((e: any) => e.sortOrder)) : -1;

  const row: QueueEntry = {
    id: nanoid(),
    threadId,
    content: entry.content,
    provider: entry.provider ?? null,
    model: entry.model ?? null,
    permissionMode: entry.permissionMode ?? null,
    images: entry.images ?? null,
    allowedTools: entry.allowedTools ?? null,
    disallowedTools: entry.disallowedTools ?? null,
    fileReferences: entry.fileReferences ?? null,
    sortOrder: maxOrder + 1,
    createdAt: new Date().toISOString(),
  };

  await dbRun(db.insert(schema.messageQueue).values(row));
  log.info('Message queued', { namespace: 'queue', threadId, messageId: row.id });
  return row;
}

/** Peek at the next message in the queue without removing it. */
export async function peek(threadId: string): Promise<QueueEntry | null> {
  const row = await dbGet(
    db
      .select()
      .from(schema.messageQueue)
      .where(eq(schema.messageQueue.threadId, threadId))
      .orderBy(asc(schema.messageQueue.sortOrder))
      .limit(1),
  );
  return (row as QueueEntry) ?? null;
}

/** Remove and return the next message from the queue. */
export async function dequeue(threadId: string): Promise<QueueEntry | null> {
  const row = await peek(threadId);
  if (!row) return null;
  await dbRun(db.delete(schema.messageQueue).where(eq(schema.messageQueue.id, row.id)));
  log.info('Message dequeued', { namespace: 'queue', threadId, messageId: row.id });
  return row;
}

/** Remove a specific queued message by ID. */
export async function cancel(messageId: string): Promise<boolean> {
  const row = await dbGet(
    db.select().from(schema.messageQueue).where(eq(schema.messageQueue.id, messageId)),
  );
  if (!row) return false;
  await dbRun(db.delete(schema.messageQueue).where(eq(schema.messageQueue.id, messageId)));
  log.info('Queued message cancelled', { namespace: 'queue', messageId });
  return true;
}

/** Update a specific queued message by ID. */
export async function update(messageId: string, content: string): Promise<QueueEntry | null> {
  const row = await dbGet(
    db.select().from(schema.messageQueue).where(eq(schema.messageQueue.id, messageId)),
  );
  if (!row) return null;

  await dbRun(
    db.update(schema.messageQueue).set({ content }).where(eq(schema.messageQueue.id, messageId)),
  );
  log.info('Queued message updated', { namespace: 'queue', messageId });
  return { ...(row as QueueEntry), content };
}

/** List all queued messages for a thread. */
export async function listQueue(threadId: string): Promise<QueueEntry[]> {
  return dbAll(
    db
      .select()
      .from(schema.messageQueue)
      .where(eq(schema.messageQueue.threadId, threadId))
      .orderBy(asc(schema.messageQueue.sortOrder)),
  ) as Promise<QueueEntry[]>;
}

/** Count queued messages for a thread. */
export async function queueCount(threadId: string): Promise<number> {
  const rows = await dbAll(
    db.select().from(schema.messageQueue).where(eq(schema.messageQueue.threadId, threadId)),
  );
  return rows.length;
}

/** Clear all queued messages for a thread. */
export async function clearQueue(threadId: string): Promise<void> {
  await dbRun(db.delete(schema.messageQueue).where(eq(schema.messageQueue.threadId, threadId)));
}
