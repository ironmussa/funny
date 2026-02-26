import { eq, asc } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db, schema } from '../db/index.js';
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
export function enqueue(
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
): QueueEntry {
  const existing = db
    .select()
    .from(schema.messageQueue)
    .where(eq(schema.messageQueue.threadId, threadId))
    .all();
  const maxOrder = existing.length > 0 ? Math.max(...existing.map((e) => e.sortOrder)) : -1;

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

  db.insert(schema.messageQueue).values(row).run();
  log.info('Message queued', { namespace: 'queue', threadId, messageId: row.id });
  return row;
}

/** Peek at the next message in the queue without removing it. */
export function peek(threadId: string): QueueEntry | null {
  const row = db
    .select()
    .from(schema.messageQueue)
    .where(eq(schema.messageQueue.threadId, threadId))
    .orderBy(asc(schema.messageQueue.sortOrder))
    .limit(1)
    .get();
  return (row as QueueEntry) ?? null;
}

/** Remove and return the next message from the queue. */
export function dequeue(threadId: string): QueueEntry | null {
  const row = peek(threadId);
  if (!row) return null;
  db.delete(schema.messageQueue).where(eq(schema.messageQueue.id, row.id)).run();
  log.info('Message dequeued', { namespace: 'queue', threadId, messageId: row.id });
  return row;
}

/** Remove a specific queued message by ID. */
export function cancel(messageId: string): boolean {
  const row = db
    .select()
    .from(schema.messageQueue)
    .where(eq(schema.messageQueue.id, messageId))
    .get();
  if (!row) return false;
  db.delete(schema.messageQueue).where(eq(schema.messageQueue.id, messageId)).run();
  log.info('Queued message cancelled', { namespace: 'queue', messageId });
  return true;
}

/** List all queued messages for a thread. */
export function listQueue(threadId: string): QueueEntry[] {
  return db
    .select()
    .from(schema.messageQueue)
    .where(eq(schema.messageQueue.threadId, threadId))
    .orderBy(asc(schema.messageQueue.sortOrder))
    .all() as QueueEntry[];
}

/** Count queued messages for a thread. */
export function queueCount(threadId: string): number {
  return db
    .select()
    .from(schema.messageQueue)
    .where(eq(schema.messageQueue.threadId, threadId))
    .all().length;
}

/** Clear all queued messages for a thread. */
export function clearQueue(threadId: string): void {
  db.delete(schema.messageQueue).where(eq(schema.messageQueue.threadId, threadId)).run();
}
