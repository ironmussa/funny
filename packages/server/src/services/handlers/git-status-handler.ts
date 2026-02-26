/**
 * Git Status handler — emits git status via WebSocket when file-modifying
 * tools are executed, ensuring the UI stays in sync with git state.
 */

/**
 * Git Status handler — emits git status via WebSocket when file-modifying
 * tools are executed, ensuring the UI stays in sync with git state.
 *
 * Fully decoupled: uses HandlerServiceContext for all git operations
 * instead of importing @funny/core/git directly.
 */

import type { GitChangedEvent } from '../thread-event-bus.js';
import type { EventHandler } from './types.js';

export const gitStatusHandler: EventHandler<'git:changed'> = {
  name: 'emit-git-status-on-change',
  event: 'git:changed',

  // Only emit for worktree threads
  filter(event: GitChangedEvent) {
    return event.worktreePath !== null;
  },

  async action(event: GitChangedEvent, ctx) {
    const { threadId, worktreePath, userId } = event;

    if (!worktreePath) return;

    const thread = ctx.getThread(threadId);
    if (!thread) return;

    const project = ctx.getProject(thread.projectId);
    if (!project) return;

    ctx.log(`Emitting git status for thread ${threadId} (tool: ${event.toolName})`);

    const summaryResult = await ctx.getGitStatusSummary(
      worktreePath,
      thread.baseBranch ?? undefined,
      project.path,
    );

    if (summaryResult.isErr()) {
      ctx.log(`Failed to get git status for thread ${threadId}: ${String(summaryResult.error)}`);
      return;
    }

    const summary = summaryResult.value;

    // Invalidate the HTTP cache so subsequent fetches don't return stale data
    ctx.invalidateGitStatusCache(project.id);

    ctx.emitToUser(userId, {
      type: 'git:status',
      threadId,
      data: {
        statuses: [
          {
            threadId,
            state: ctx.deriveGitSyncState(summary),
            ...summary,
          },
        ],
      },
    });
  },
};
