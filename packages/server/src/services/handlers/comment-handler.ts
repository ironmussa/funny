/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: handler
 * @domain layer: application
 * @domain consumes: agent:completed
 *
 * Creates system comments when agents complete.
 */

import type { AgentCompletedEvent } from '../thread-event-bus.js';
import type { EventHandler } from './types.js';

export const commentHandler: EventHandler<'agent:completed'> = {
  name: 'comment-on-completion',
  event: 'agent:completed',

  async action(event: AgentCompletedEvent, ctx) {
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

    await ctx.insertComment({ threadId, userId, source: 'system', content });
  },
};
