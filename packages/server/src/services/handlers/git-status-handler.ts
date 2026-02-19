/**
 * Git Status handler — emits git status via WebSocket when file-modifying
 * tools are executed, ensuring the UI stays in sync with git state.
 */

import type { EventHandler } from './types.js';
import type { GitChangedEvent } from '../thread-event-bus.js';
import { getStatusSummary, deriveGitSyncState } from '@funny/core/git';
import { log } from '../../lib/abbacchio.js';

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

    log.debug('Emitting git status', { namespace: 'git-status-handler', threadId, toolName: event.toolName });

    const summaryResult = await getStatusSummary(
      worktreePath,
      thread.baseBranch ?? undefined,
      project.path
    );

    if (summaryResult.isErr()) {
      log.error('Failed to get git status', { namespace: 'git-status-handler', threadId, error: String(summaryResult.error) });
      return;
    }

    const summary = summaryResult.value;

    ctx.emitToUser(userId, {
      type: 'git:status',
      threadId,
      data: {
        statuses: [{
          threadId,
          state: deriveGitSyncState(summary),
          ...summary,
        }],
      },
    });
  },
};
