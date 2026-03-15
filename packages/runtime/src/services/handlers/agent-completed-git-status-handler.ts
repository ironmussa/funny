/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: handler
 * @domain layer: application
 * @domain consumes: agent:completed
 * @domain emits: git:status
 */

import { invalidateStatusCache } from '@funny/core/git';

import type { AgentCompletedEvent } from '../thread-event-bus.js';
import type { EventHandler } from './types.js';

export const agentCompletedGitStatusHandler: EventHandler<'agent:completed'> = {
  name: 'refresh-git-status-on-agent-completed',
  event: 'agent:completed',

  async action(event: AgentCompletedEvent, ctx) {
    const { threadId, userId, worktreePath, cwd } = event;

    const thread = await ctx.getThread(threadId);
    if (!thread) return;

    const project = await ctx.getProject(thread.projectId);
    if (!project) return;

    const effectiveCwd = worktreePath ?? cwd;
    if (!effectiveCwd) return;

    ctx.log(`Refreshing git status after agent ${event.status} for thread ${threadId}`);

    // Invalidate core-level cache so we get fresh data after agent modifications
    invalidateStatusCache(effectiveCwd);

    const summaryResult = await ctx.getGitStatusSummary(
      effectiveCwd,
      thread.baseBranch ?? undefined,
      project.path,
    );

    if (summaryResult.isErr()) {
      ctx.log(
        `Failed to get git status for thread ${threadId}: [${summaryResult.error.type}] ${summaryResult.error.message}`,
      );
      return;
    }

    const summary = summaryResult.value;

    // Invalidate the HTTP cache so subsequent fetches don't return stale data
    ctx.invalidateGitStatusCache(project.id);

    const branchKey = thread.branch
      ? `${thread.projectId}:${thread.branch}`
      : thread.baseBranch && thread.mergedAt
        ? `tid:${threadId}`
        : thread.projectId;

    ctx.emitToUser(userId, {
      type: 'git:status',
      threadId,
      data: {
        statuses: [
          {
            threadId,
            branchKey,
            state: ctx.deriveGitSyncState(summary),
            ...summary,
          },
        ],
      },
    });
  },
};
