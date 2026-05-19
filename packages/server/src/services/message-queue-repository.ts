/**
 * Message queue CRUD backed by the server's database.
 */

import { eq, asc } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db, dbAll, dbGet, dbRun } from '../db/index.js';
import { messageQueue } from '../db/schema.js';
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
    db.select().from(messageQueue).where(eq(messageQueue.threadId, threadId)),
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

  await dbRun(db.insert(messageQueue).values(row));
  log.info('Message queued', { namespace: 'queue', threadId, messageId: row.id });
  return row;
}

export async function peek(threadId: string): Promise<QueueEntry | null> {
  const row = await dbGet(
    db
      .select()
      .from(messageQueue)
      .where(eq(messageQueue.threadId, threadId))
      .orderBy(asc(messageQueue.sortOrder))
      .limit(1),
  );
  return (row as QueueEntry) ?? null;
}

export async function dequeue(threadId: string): Promise<QueueEntry | null> {
  const row = await peek(threadId);
  if (!row) return null;
  await dbRun(db.delete(messageQueue).where(eq(messageQueue.id, row.id)));
  log.info('Message dequeued', { namespace: 'queue', threadId, messageId: row.id });
  return row;
}

export async function cancel(messageId: string, threadId: string): Promise<boolean> {
  const row = (await dbGet(db.select().from(messageQueue).where(eq(messageQueue.id, messageId)))) as
    | QueueEntry
    | undefined;
  if (!row || row.threadId !== threadId) return false;
  await dbRun(db.delete(messageQueue).where(eq(messageQueue.id, messageId)));
  log.info('Queued message cancelled', { namespace: 'queue', messageId });
  return true;
}

export async function update(
  messageId: string,
  threadId: string,
  content: string,
): Promise<QueueEntry | null> {
  const row = (await dbGet(db.select().from(messageQueue).where(eq(messageQueue.id, messageId)))) as
    | QueueEntry
    | undefined;
  if (!row || row.threadId !== threadId) return null;

  await dbRun(db.update(messageQueue).set({ content }).where(eq(messageQueue.id, messageId)));
  log.info('Queued message updated', { namespace: 'queue', messageId });
  return { ...row, content };
}

export async function listQueue(threadId: string): Promise<QueueEntry[]> {
  return dbAll(
    db
      .select()
      .from(messageQueue)
      .where(eq(messageQueue.threadId, threadId))
      .orderBy(asc(messageQueue.sortOrder)),
  ) as Promise<QueueEntry[]>;
}

export async function queueCount(threadId: string): Promise<number> {
  const rows = await dbAll(
    db.select().from(messageQueue).where(eq(messageQueue.threadId, threadId)),
  );
  return rows.length;
}

export async function clearQueue(threadId: string): Promise<void> {
  await dbRun(db.delete(messageQueue).where(eq(messageQueue.threadId, threadId)));
}
