/**
 * Git Event Persistence handlers — persist git operation events
 * (commit, push, merge) to the database via the reactive event bus.
 *
 * Decouples route handlers from direct thread-event-service calls.
 */

import type { EventHandler } from './types.js';
import type { GitCommittedEvent, GitPushedEvent, GitMergedEvent } from '../thread-event-bus.js';

export const gitCommitPersistenceHandler: EventHandler<'git:committed'> = {
  name: 'persist-git-commit',
  event: 'git:committed',

  async action(event: GitCommittedEvent, ctx) {
    await ctx.saveThreadEvent(event.threadId, 'git:commit', {
      message: event.message,
      amend: event.amend,
      cwd: event.cwd,
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
  },
};
