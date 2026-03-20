/**
 * @domain subdomain: Agent Execution
 * @domain subdomain-type: core
 * @domain type: handler
 * @domain layer: application
 * @domain consumes: agent:completed
 * @domain depends: MessageQueue, AgentRunner
 *
 * Drains the message queue when an agent completes, fails, or is stopped.
 * If the project uses queue mode and there's a queued message, it auto-starts
 * the agent with the next message in the queue.
 */

import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_FOLLOW_UP_MODE,
} from '@funny/shared/models';

import type { AgentCompletedEvent } from '../thread-event-bus.js';
import type { EventHandler } from './types.js';

export const agentCompletedQueueHandler: EventHandler<'agent:completed'> = {
  name: 'drain-message-queue-on-completion',
  event: 'agent:completed',

  async action(event: AgentCompletedEvent, ctx) {
    const { threadId } = event;

    const thread = await ctx.getThread(threadId);
    if (!thread) return;

    const project = await ctx.getProject(thread.projectId);
    if (!project) return;
    const mode = project?.followUpMode ?? DEFAULT_FOLLOW_UP_MODE;
    if (mode !== 'queue' && mode !== 'ask') return;

    const next = await ctx.dequeueMessage(threadId);
    if (!next) return;

    ctx.log(`Auto-sending queued message for thread ${threadId} (messageId: ${next.id})`);

    const effectiveCwd = thread.worktreePath ?? project.path;

    try {
      // skipMessageInsert: true — the user message was already inserted when
      // the message was enqueued in thread-service.ts, avoid duplicates.
      await ctx.startAgent(
        threadId,
        next.content,
        effectiveCwd,
        next.model || thread.model || DEFAULT_MODEL,
        next.permissionMode || thread.permissionMode || DEFAULT_PERMISSION_MODE,
        next.images ? JSON.parse(next.images) : undefined,
        next.disallowedTools ? JSON.parse(next.disallowedTools) : undefined,
        next.allowedTools ? JSON.parse(next.allowedTools) : undefined,
        next.provider || thread.provider || DEFAULT_PROVIDER,
        true, // skipMessageInsert
      );

      // Emit queue update with the dequeued message content so the client
      // can inject the user message into the thread (optimistic rendering
      // is skipped for queued messages to avoid showing them prematurely)
      const remaining = await ctx.queueCount(threadId);
      const peekNext = await ctx.peekMessage(threadId);
      const queueEvent = {
        type: 'thread:queue_update' as const,
        threadId,
        data: {
          threadId,
          queuedCount: remaining,
          nextMessage: peekNext?.content?.slice(0, 100),
          dequeuedMessage: next.content,
          dequeuedImages: next.images ? JSON.parse(next.images) : undefined,
        },
      };
      if (thread.userId) {
        ctx.emitToUser(thread.userId, queueEvent);
      } else {
        ctx.broadcast(queueEvent);
      }
    } catch (err: any) {
      ctx.log(`Failed to auto-send queued message for thread ${threadId}: ${err.message}`);

      // Re-enqueue the message so it's not lost — the user can still see it
      // in the queue widget and it will be retried on the next completion.
      try {
        await ctx.enqueueMessage(threadId, {
          content: next.content,
          provider: next.provider ?? undefined,
          model: next.model ?? undefined,
          permissionMode: next.permissionMode ?? undefined,
          images: next.images ?? undefined,
          allowedTools: next.allowedTools ?? undefined,
          disallowedTools: next.disallowedTools ?? undefined,
          fileReferences: next.fileReferences ?? undefined,
        });
        ctx.log(`Re-enqueued message ${next.id} after failed auto-send`);
      } catch (reEnqueueErr: any) {
        ctx.log(`CRITICAL: Failed to re-enqueue message ${next.id}: ${reEnqueueErr.message}`);
      }
    }
  },
};
