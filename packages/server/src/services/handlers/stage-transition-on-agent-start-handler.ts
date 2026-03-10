/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: handler
 * @domain layer: application
 * @domain consumes: agent:started
 *
 * Auto-transitions thread stage to 'in_progress' when an agent starts,
 * if the thread is currently in backlog, planning, or review.
 */

import type { AgentStartedEvent } from '../thread-event-bus.js';
import type { EventHandler } from './types.js';

export const stageTransitionOnAgentStartHandler: EventHandler<'agent:started'> = {
  name: 'transition-stage-on-agent-start',
  event: 'agent:started',

  async filter(event: AgentStartedEvent, ctx) {
    const thread = await ctx.getThread(event.threadId);
    if (!thread) return false;
    return thread.stage === 'backlog' || thread.stage === 'planning' || thread.stage === 'review';
  },

  async action(event: AgentStartedEvent, ctx) {
    const thread = await ctx.getThread(event.threadId);
    if (!thread) return;
    await ctx.updateThread(event.threadId, { stage: 'in_progress' });
    ctx.emitToUser(event.userId, {
      type: 'agent:status',
      threadId: event.threadId,
      data: { status: 'running', stage: 'in_progress' },
    });
  },
};
