/**
 * @domain subdomain: Agent Execution
 * @domain subdomain-type: core
 * @domain type: handler
 * @domain layer: application
 * @domain consumes: agent:completed
 * @domain depends: MessageQueue, AgentRunner
 *
 * Drains the message queue when an agent completes, fails, or is stopped.
 * If there's a queued message, it auto-starts the agent with the next one, in
 * the thread's working directory (project, worktree or scratch directory).
 */

import { DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_PERMISSION_MODE } from '@funny/shared/models';
import { Result } from 'neverthrow';

import { resolveThreadCwd } from '../thread-context.js';
import type { AgentCompletedEvent } from '../thread-event-bus.js';
import type { EventHandler } from './types.js';

export const agentCompletedQueueHandler: EventHandler<'agent:completed'> = {
  name: 'drain-message-queue-on-completion',
  event: 'agent:completed',

  async action(event: AgentCompletedEvent, ctx) {
    const { threadId } = event;

    const thread = await ctx.getThread(threadId);
    if (!thread) return;

    // Drain whatever was queued, whatever the project's follow-up mode: a
    // non-queue project still queues a send that forced it (`forceQueue`) or
    // that would have cut a heavy-thinking turn, and a scratch thread has no
    // project at all (#194). An empty queue makes this a no-op.
    const project = thread.projectId ? await ctx.getProject(thread.projectId) : null;
    const cwdResult = Result.fromThrowable(
      () =>
        resolveThreadCwd(
          {
            id: thread.id,
            userId: thread.userId,
            isScratch: !!thread.isScratch,
            mode: thread.mode === 'worktree' ? 'worktree' : 'local',
            worktreePath: thread.worktreePath ?? undefined,
          },
          project ?? null,
        ),
      // scratchPathFor throws on a malformed id; treat it like any other miss.
      (e) => ({ message: e instanceof Error ? e.message : String(e) }),
    )().andThen((r) => r);
    if (cwdResult.isErr()) {
      // Leave the queue intact: the message is not lost, only not sent yet.
      ctx.log(`Not draining queue for thread ${threadId}: ${cwdResult.error.message}`);
      return;
    }
    const cwd = cwdResult.value;

    const next = await ctx.dequeueMessage(threadId);
    if (!next) return;

    ctx.log(`Auto-sending queued message for thread ${threadId} (messageId: ${next.id})`);

    try {
      // skipMessageInsert: false — when sendMessage decided to queue, it
      // intentionally did NOT persist the user message to the messages
      // table (only to the queue). Insert it now so the message lands in
      // the thread with a timestamp matching when the agent actually
      // starts processing it, and with no duplicate vs. the client-side
      // dequeue buffer.
      await ctx.startAgent(
        threadId,
        next.content,
        cwd,
        next.model || thread.model || DEFAULT_MODEL,
        next.permissionMode || thread.permissionMode || DEFAULT_PERMISSION_MODE,
        next.images ? JSON.parse(next.images) : undefined,
        next.disallowedTools ? JSON.parse(next.disallowedTools) : undefined,
        next.allowedTools ? JSON.parse(next.allowedTools) : undefined,
        next.provider || thread.provider || DEFAULT_PROVIDER,
        false, // skipMessageInsert
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
