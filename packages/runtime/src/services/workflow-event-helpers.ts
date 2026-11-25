/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: helper
 * @domain layer: application
 *
 * Shared helpers for emitting workflow thread events (save to DB + broadcast via WS).
 * Used by both git-pipelines.ts and git-workflow-service.ts.
 */

import type { ThreadEventType, WSEvent } from '@funny/shared';

import type { ThreadEventData } from './server-interfaces.js';
import { getServices } from './service-registry.js';
import { wsBroker } from './ws-broker.js';

type WorkflowEventType = ThreadEventType | `workflow:${string}`;

/** Broadcast a thread event over WebSocket without persisting it. */
function broadcastThreadEvent(
  userId: string,
  threadId: string,
  type: WorkflowEventType,
  data: ThreadEventData,
) {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  wsBroker.emitToUser(userId, {
    type: 'thread:event',
    threadId,
    data: {
      event: { id, threadId, type, data: JSON.stringify(data), createdAt },
    },
  } as WSEvent);
}

/** Persist a thread event to the DB and broadcast it via WebSocket. */
export async function emitWorkflowEvent(
  userId: string,
  threadId: string,
  type: WorkflowEventType,
  data: ThreadEventData,
) {
  await getServices().threadEvents.saveThreadEvent(threadId, type, data);
  broadcastThreadEvent(userId, threadId, type, data);
}
