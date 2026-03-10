/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: handler
 * @domain layer: application
 * @domain consumes: thread:created, thread:deleted
 *
 * Manages git file-system watcher lifecycle:
 * - Starts watching when a thread is created
 * - Stops watching when a thread is deleted
 */

import { startWatching, stopWatching } from '../git-watcher-service.js';
import type { ThreadCreatedEvent, ThreadDeletedEvent } from '../thread-event-bus.js';
import type { EventHandler } from './types.js';

export const gitWatcherStartHandler: EventHandler<'thread:created'> = {
  name: 'git-watcher-start-on-thread-created',
  event: 'thread:created',

  async action(event: ThreadCreatedEvent, ctx) {
    // Always use the project path (where .git/ lives), not the worktree path
    const project = await ctx.getProject(event.projectId);
    if (!project) return;
    startWatching(event.projectId, project.path, event.threadId);
  },
};

export const gitWatcherStopHandler: EventHandler<'thread:deleted'> = {
  name: 'git-watcher-stop-on-thread-deleted',
  event: 'thread:deleted',

  action(event: ThreadDeletedEvent) {
    stopWatching(event.projectId, event.threadId);
  },
};
