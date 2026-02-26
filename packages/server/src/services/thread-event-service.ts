/**
 * Thread Event Service — Persists thread events (git operations, status changes)
 * to the database for historical tracking and UI display.
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

/**
 * Create a new thread event in the database
 */
export async function createThreadEvent(event: ThreadEvent): Promise<void> {
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

    log.debug('[thread-event-service] Event persisted', {
      eventId,
      threadId: event.threadId,
      type: event.type,
    });
  } catch (error) {
    log.error('[thread-event-service] Failed to persist event', {
      error,
      event,
    });
  }
}

/**
 * Convenience wrapper: save a thread event by individual arguments.
 */
export async function saveThreadEvent(
  threadId: string,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  return createThreadEvent({ threadId, type, data });
}

/**
 * Get all events for a thread, ordered by createdAt descending
 */
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
    log.error('[thread-event-service] Failed to retrieve events', {
      error,
      threadId,
    });
    return [];
  }
}

/**
 * Delete all events for a thread
 */
export async function deleteThreadEvents(threadId: string): Promise<void> {
  try {
    await db.delete(threadEvents).where(eq(threadEvents.threadId, threadId));
    log.debug('[thread-event-service] Events deleted', { threadId });
  } catch (error) {
    log.error('[thread-event-service] Failed to delete events', {
      error,
      threadId,
    });
  }
}
