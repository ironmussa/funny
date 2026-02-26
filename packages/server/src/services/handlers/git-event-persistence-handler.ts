/**
 * Git Event Persistence handlers — persist git operation events
 * (commit, push, merge) to the database via the reactive event bus.
 * Also broadcasts thread:event WS events so the client can show them inline.
 *
 * Decouples route handlers from direct thread-event-service calls.
 */

import type { GitCommittedEvent, GitPushedEvent, GitMergedEvent } from '../thread-event-bus.js';
import type { EventHandler } from './types.js';
import type { HandlerServiceContext } from './types.js';

function broadcastThreadEvent(
  ctx: HandlerServiceContext,
  userId: string,
  threadId: string,
  type: string,
  data: Record<string, unknown>,
) {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  ctx.emitToUser(userId, {
    type: 'thread:event',
    threadId,
    data: {
      event: { id, threadId, type, data: JSON.stringify(data), createdAt },
    },
  });
}

export const gitCommitPersistenceHandler: EventHandler<'git:committed'> = {
  name: 'persist-git-commit',
  event: 'git:committed',

  async action(event: GitCommittedEvent, ctx) {
    await ctx.saveThreadEvent(event.threadId, 'git:commit', {
      message: event.message,
      amend: event.amend,
      cwd: event.cwd,
    });
    broadcastThreadEvent(ctx, event.userId, event.threadId, 'git:commit', {
      message: event.message,
      amend: event.amend,
    });
  },
};

export const gitPushPersistenceHandler: EventHandler<'git:pushed'> = {
  name: 'persist-git-push',
  event: 'git:pushed',

  async action(event: GitPushedEvent, ctx) {
    await ctx.saveThreadEvent(event.threadId, 'git:push', {
      cwd: event.cwd,
    });
    broadcastThreadEvent(ctx, event.userId, event.threadId, 'git:push', {});
  },
};

export const gitMergePersistenceHandler: EventHandler<'git:merged'> = {
  name: 'persist-git-merge',
  event: 'git:merged',

  async action(event: GitMergedEvent, ctx) {
    await ctx.saveThreadEvent(event.threadId, 'git:merge', {
      sourceBranch: event.sourceBranch,
      targetBranch: event.targetBranch,
      output: event.output,
    });
    broadcastThreadEvent(ctx, event.userId, event.threadId, 'git:merge', {
      sourceBranch: event.sourceBranch,
      targetBranch: event.targetBranch,
    });
  },
};
