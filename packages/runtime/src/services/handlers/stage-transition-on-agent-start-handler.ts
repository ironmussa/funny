/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: handler
 * @domain layer: application
 * @domain consumes: agent:started
 *
 * Auto-transitions running backlog/planning/review threads to in_progress when
 * an agent starts.
 */

import type { AgentStartedEvent } from '../thread-event-bus.js';
import { transitionThreadLifecycle } from '../thread-lifecycle-machine.js';
import type { EventHandler } from './types.js';

export const stageTransitionOnAgentStartHandler: EventHandler<'agent:started'> = {
  name: 'transition-stage-on-agent-start',
  event: 'agent:started',

  async filter(event: AgentStartedEvent, ctx) {
    const thread = await ctx.getThread(event.threadId);
    if (!thread) return false;
    return transitionThreadLifecycle(thread, { type: 'AGENT_STARTED' }) !== null;
  },

  async action(event: AgentStartedEvent, ctx) {
    const thread = await ctx.getThread(event.threadId);
    if (!thread) return;
    const transition = transitionThreadLifecycle(thread, { type: 'AGENT_STARTED' });
    if (!transition) return;
    await ctx.updateThread(event.threadId, transition.updates);
    if (transition.clientStatus) {
      ctx.emitToUser(event.userId, {
        type: 'agent:status',
        threadId: event.threadId,
        data: transition.clientStatus,
      });
    }
  },
};
