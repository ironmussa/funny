/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: handler
 * @domain layer: application
 * @domain consumes: thread:deleted
 * @domain emits: thread:deleted
 *
 * Forwards thread:deleted events to WebSocket clients so the UI
 * can remove the thread without a manual refresh.
 */

import type { ThreadDeletedEvent } from '../thread-event-bus.js';
import type { EventHandler } from './types.js';

export const threadDeletedWsHandler: EventHandler<'thread:deleted'> = {
  name: 'broadcast-thread-deleted',
  event: 'thread:deleted',

  action(event: ThreadDeletedEvent, ctx) {
    ctx.emitToUser(event.userId, {
      type: 'thread:deleted',
      threadId: event.threadId,
      data: { projectId: event.projectId },
    });
  },
};
