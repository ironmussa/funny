/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: handler
 * @domain layer: application
 * @domain consumes: thread:stage-changed
 * @domain emits: thread:stage-changed
 *
 * Forwards thread:stage-changed events to WebSocket clients so the UI
 * can update the Kanban board in real time.
 */

import type { ThreadStageChangedEvent } from '../thread-event-bus.js';
import type { EventHandler } from './types.js';

export const threadStageChangedWsHandler: EventHandler<'thread:stage-changed'> = {
  name: 'broadcast-thread-stage-changed',
  event: 'thread:stage-changed',

  action(event: ThreadStageChangedEvent, ctx) {
    ctx.emitToUser(event.userId, {
      type: 'thread:stage-changed',
      threadId: event.threadId,
      data: {
        fromStage: event.fromStage,
        toStage: event.toStage,
        projectId: event.projectId,
      },
    });
  },
};
