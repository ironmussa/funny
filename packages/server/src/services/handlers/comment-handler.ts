/**
 * Comment handler — creates system comments when agents complete.
 *
 * Replaces the old comment-subscriber.ts with the reactive handler pattern.
 */

import type { AgentCompletedEvent } from '../thread-event-bus.js';
import type { EventHandler } from './types.js';

export const commentHandler: EventHandler<'agent:completed'> = {
  name: 'comment-on-completion',
  event: 'agent:completed',

  action(event: AgentCompletedEvent, ctx) {
    const { threadId, userId, status, cost } = event;

    let content: string;
    switch (status) {
      case 'completed':
        content = `Agent completed. Cost: $${cost.toFixed(4)}`;
        break;
      case 'failed':
        content = `Agent failed. Cost: $${cost.toFixed(4)}`;
        break;
      case 'stopped':
        content = 'Agent stopped by user.';
        break;
      default:
        return;
    }

    ctx.insertComment({ threadId, userId, source: 'system', content });
  },
};
