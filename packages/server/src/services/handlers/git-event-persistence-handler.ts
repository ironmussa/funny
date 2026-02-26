/**
 * Git Event Persistence handlers — persist git operation events
 * (commit, push, merge) to the database via the reactive event bus.
 * Also broadcasts thread:event WS events so the client can show them inline.
 *
 * Decouples route handlers from direct thread-event-service calls.
 */

import type {
  GitCommittedEvent,
  GitPushedEvent,
  GitMergedEvent,
  GitStagedEvent,
  GitUnstagedEvent,
  GitRevertedEvent,
  GitPulledEvent,
  GitStashedEvent,
  GitStashPoppedEvent,
  GitResetSoftEvent,
} from '../thread-event-bus.js';
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

export const gitStagePersistenceHandler: EventHandler<'git:staged'> = {
  name: 'persist-git-stage',
  event: 'git:staged',

  async action(event: GitStagedEvent, ctx) {
    await ctx.saveThreadEvent(event.threadId, 'git:stage', {
      paths: event.paths,
      cwd: event.cwd,
    });
    broadcastThreadEvent(ctx, event.userId, event.threadId, 'git:stage', {
      paths: event.paths,
    });
  },
};

export const gitUnstagePersistenceHandler: EventHandler<'git:unstaged'> = {
  name: 'persist-git-unstage',
  event: 'git:unstaged',

  async action(event: GitUnstagedEvent, ctx) {
    await ctx.saveThreadEvent(event.threadId, 'git:unstage', {
      paths: event.paths,
      cwd: event.cwd,
    });
    broadcastThreadEvent(ctx, event.userId, event.threadId, 'git:unstage', {
      paths: event.paths,
    });
  },
};

export const gitRevertPersistenceHandler: EventHandler<'git:reverted'> = {
  name: 'persist-git-revert',
  event: 'git:reverted',

  async action(event: GitRevertedEvent, ctx) {
    await ctx.saveThreadEvent(event.threadId, 'git:revert', {
      paths: event.paths,
      cwd: event.cwd,
    });
    broadcastThreadEvent(ctx, event.userId, event.threadId, 'git:revert', {
      paths: event.paths,
    });
  },
};

export const gitPullPersistenceHandler: EventHandler<'git:pulled'> = {
  name: 'persist-git-pull',
  event: 'git:pulled',

  async action(event: GitPulledEvent, ctx) {
    await ctx.saveThreadEvent(event.threadId, 'git:pull', {
      output: event.output,
      cwd: event.cwd,
    });
    broadcastThreadEvent(ctx, event.userId, event.threadId, 'git:pull', {
      output: event.output,
    });
  },
};

export const gitStashPersistenceHandler: EventHandler<'git:stashed'> = {
  name: 'persist-git-stash',
  event: 'git:stashed',

  async action(event: GitStashedEvent, ctx) {
    await ctx.saveThreadEvent(event.threadId, 'git:stash', {
      output: event.output,
      cwd: event.cwd,
    });
    broadcastThreadEvent(ctx, event.userId, event.threadId, 'git:stash', {
      output: event.output,
    });
  },
};

export const gitStashPopPersistenceHandler: EventHandler<'git:stash-popped'> = {
  name: 'persist-git-stash-pop',
  event: 'git:stash-popped',

  async action(event: GitStashPoppedEvent, ctx) {
    await ctx.saveThreadEvent(event.threadId, 'git:stash_pop', {
      output: event.output,
      cwd: event.cwd,
    });
    broadcastThreadEvent(ctx, event.userId, event.threadId, 'git:stash_pop', {
      output: event.output,
    });
  },
};

export const gitResetSoftPersistenceHandler: EventHandler<'git:reset-soft'> = {
  name: 'persist-git-reset-soft',
  event: 'git:reset-soft',

  async action(event: GitResetSoftEvent, ctx) {
    await ctx.saveThreadEvent(event.threadId, 'git:reset_soft', {
      output: event.output,
      cwd: event.cwd,
    });
    broadcastThreadEvent(ctx, event.userId, event.threadId, 'git:reset_soft', {
      output: event.output,
    });
  },
};
