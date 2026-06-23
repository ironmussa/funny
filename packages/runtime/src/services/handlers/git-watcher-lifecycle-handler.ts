/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: handler
 * @domain layer: application
 * @domain consumes: thread:created, thread:deleted, agent:started, agent:completed
 *
 * Manages git file-system watcher lifecycle:
 * - Starts watching when a thread is created or an agent run starts
 * - Stops watching when a thread is deleted or an agent run completes
 *
 * Only threads with an active agent run are registered — completed/idle
 * threads don't need real-time git status updates and were causing a
 * thundering-herd problem when projects had hundreds of threads.
 */

import { startWatching, stopWatching } from '../git-watcher-service.js';
import type {
  ThreadCreatedEvent,
  ThreadDeletedEvent,
  AgentStartedEvent,
  AgentCompletedEvent,
} from '../thread-event-bus.js';
import type { EventHandler } from './types.js';

export const gitWatcherStartHandler: EventHandler<'thread:created'> = {
  name: 'git-watcher-start-on-thread-created',
  event: 'thread:created',

  async action(event: ThreadCreatedEvent, ctx) {
    // Always use the project path (where .git/ lives), not the worktree path
    const project = await ctx.getProject(event.projectId);
    if (!project) return;
    startWatching(
      event.projectId,
      project.path,
      event.threadId,
      event.userId,
      event.worktreePath ?? null,
    );
  },
};

export const gitWatcherStopHandler: EventHandler<'thread:deleted'> = {
  name: 'git-watcher-stop-on-thread-deleted',
  event: 'thread:deleted',

  action(event: ThreadDeletedEvent) {
    stopWatching(event.projectId, event.threadId);
  },
};

export const gitWatcherStartOnAgentStartHandler: EventHandler<'agent:started'> = {
  name: 'git-watcher-start-on-agent-started',
  event: 'agent:started',

  async action(event: AgentStartedEvent, ctx) {
    const project = await ctx.getProject(event.projectId);
    if (!project) return;
    startWatching(
      event.projectId,
      project.path,
      event.threadId,
      event.userId,
      event.worktreePath ?? null,
    );
  },
};

export const gitWatcherStopOnAgentCompletedHandler: EventHandler<'agent:completed'> = {
  name: 'git-watcher-stop-on-agent-completed',
  event: 'agent:completed',

  action(event: AgentCompletedEvent) {
    // Waiting status means the agent will resume — keep watching
    if ((event.status as string) === 'waiting') return;
    stopWatching(event.projectId, event.threadId);
  },
};
