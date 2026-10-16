/**
 * Thread event persistence backed by the server's database.
 */

import { eq, desc } from 'drizzle-orm';

import { db } from '../db/index.js';
import { threadEvents } from '../db/schema.js';
import { log } from '../lib/logger.js';

export interface ThreadEvent {
  id?: string;
  threadId: string;
  type: string;
  data: Record<string, unknown>;
  timestamp?: number;
}

async function createThreadEvent(event: ThreadEvent): Promise<void> {
  try {
    const eventId = event.id || crypto.randomUUID();
    const createdAt = event.timestamp
      ? new Date(event.timestamp).toISOString()
      : new Date().toISOString();

    await db.insert(threadEvents).values({
      id: eventId,
      threadId: event.threadId,
      eventType: event.type,
      data: JSON.stringify(event.data),
      createdAt,
    });
  } catch (error) {
    log.error('Failed to persist event', {
      namespace: 'thread-event',
      error,
      event,
    });
  }
}

export async function saveThreadEvent(
  threadId: string,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  return createThreadEvent({ threadId, type, data });
}

export async function getThreadEvents(threadId: string): Promise<ThreadEvent[]> {
  try {
    const rows = await db
      .select()
      .from(threadEvents)
      .where(eq(threadEvents.threadId, threadId))
      .orderBy(desc(threadEvents.createdAt));

    return rows.map((row) => ({
      id: row.id,
      threadId: row.threadId,
      type: row.eventType,
      data: JSON.parse(row.data),
      createdAt: row.createdAt,
    }));
  } catch (error) {
    log.error('Failed to retrieve events', { namespace: 'thread-event', error, threadId });
    return [];
  }
}
