/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: helper
 * @domain layer: application
 *
 * Shared helpers for emitting workflow thread events (save to DB + broadcast via WS).
 * Used by both git-pipelines.ts and git-workflow-service.ts.
 */

import { saveThreadEvent } from './thread-event-service.js';
import { wsBroker } from './ws-broker.js';

/** Broadcast a thread event over WebSocket without persisting it. */
export function broadcastThreadEvent(
  userId: string,
  threadId: string,
  type: string,
  data: Record<string, unknown>,
) {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  wsBroker.emitToUser(userId, {
    type: 'thread:event',
    threadId,
    data: {
      event: { id, threadId, type, data: JSON.stringify(data), createdAt },
    },
  });
}

/** Persist a thread event to the DB and broadcast it via WebSocket. */
export async function emitWorkflowEvent(
  userId: string,
  threadId: string,
  type: string,
  data: Record<string, unknown>,
) {
  await saveThreadEvent(threadId, type, data);
  broadcastThreadEvent(userId, threadId, type, data);
}
