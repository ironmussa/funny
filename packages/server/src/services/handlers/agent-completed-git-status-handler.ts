/**
 * Refreshes git status via WebSocket when an agent completes/stops/fails.
 *
 * Without this, the UI can show stale "uncommitted changes" after the agent
 * finishes — the git:changed handler only fires during tool executions,
 * so if the agent's final state differs from the last mid-run snapshot,
 * the client never learns about it.
 */

import type { AgentCompletedEvent } from '../thread-event-bus.js';
import type { EventHandler } from './types.js';

export const agentCompletedGitStatusHandler: EventHandler<'agent:completed'> = {
  name: 'refresh-git-status-on-agent-completed',
  event: 'agent:completed',

  async action(event: AgentCompletedEvent, ctx) {
    const { threadId, userId, worktreePath, cwd } = event;

    const thread = ctx.getThread(threadId);
    if (!thread) return;

    const project = ctx.getProject(thread.projectId);
    if (!project) return;

    const effectiveCwd = worktreePath ?? cwd;
    if (!effectiveCwd) return;

    ctx.log(`Refreshing git status after agent ${event.status} for thread ${threadId}`);

    const summaryResult = await ctx.getGitStatusSummary(
      effectiveCwd,
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
