/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: handler
 * @domain layer: application
 * @domain consumes: git:changed
 * @domain emits: git:status
 *
 * Emits git status via WebSocket when file-modifying tools are executed.
 * Uses per-thread debouncing to avoid flooding getStatusSummary().
 */

import { invalidateStatusCache } from '@funny/core/git';

import type { GitChangedEvent } from '../thread-event-bus.js';
import type { EventHandler, HandlerServiceContext } from './types.js';

// Per-thread debounce state
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 500;

export const gitStatusHandler: EventHandler<'git:changed'> = {
  name: 'emit-git-status-on-change',
  event: 'git:changed',

  action(event: GitChangedEvent, ctx) {
    const { threadId } = event;

    // Clear any pending timer for this thread
    const existing = pendingTimers.get(threadId);
    if (existing) clearTimeout(existing);

    // Schedule the actual work after debounce period
    pendingTimers.set(
      threadId,
      setTimeout(() => {
        pendingTimers.delete(threadId);
        void emitGitStatus(event, ctx);
      }, DEBOUNCE_MS),
    );
  },
};

async function emitGitStatus(event: GitChangedEvent, ctx: HandlerServiceContext) {
  const { threadId, worktreePath, userId, cwd } = event;

  // Use worktreePath if available, otherwise fall back to cwd (local-mode threads)
  const effectiveCwd = worktreePath ?? cwd;
  if (!effectiveCwd) return;

  const thread = await ctx.getThread(threadId);
  if (!thread) return;

  const project = await ctx.getProject(thread.projectId);
  if (!project) return;

  ctx.log(`Emitting git status for thread ${threadId} (debounced, tool: ${event.toolName})`);

  // Invalidate core-level cache so we get fresh data after the file modification
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
}

/** Clear pending debounce timer for a thread (e.g. on thread deletion). */
export function clearGitStatusDebounce(threadId: string): void {
  const timer = pendingTimers.get(threadId);
  if (timer) {
    clearTimeout(timer);
    pendingTimers.delete(threadId);
  }
}
