/**
 * Shared git-status helpers used by route handlers and event handlers.
 */

import {
  invalidateStatusCache,
  getStatusSummary,
  getPRForBranch,
  getCurrentBranch,
} from '@funny/core/git';

import { deriveGitSyncState } from '../services/git-service.js';
import type { HandlerServiceContext } from '../services/handlers/types.js';

/** Compute a stable cache key that groups threads sharing the same git working state. */
export function computeBranchKey(thread: {
  id: string;
  projectId: string;
  mode?: string | null;
  branch?: string | null;
  worktreePath?: string | null;
  baseBranch?: string | null;
  mergedAt?: string | null;
}): string {
  // Merged threads (worktree cleaned up, mergedAt set): unique per thread
  if (!thread.branch && !thread.worktreePath && thread.baseBranch && thread.mergedAt)
    return `tid:${thread.id}`;
  // Worktree threads: always unique per thread — each worktree has its own
  // working directory so even threads on the same branch have independent state.
  // Use `mode` as the primary signal (worktreePath may be null if the worktree
  // was cleaned up but the thread hasn't been archived yet).
  if ((thread.mode === 'worktree' || thread.worktreePath) && thread.branch)
    return `wt:${thread.projectId}:${thread.branch}:${thread.id}`;
  // Local threads with a branch: group by project + branch (they share the project cwd)
  if (thread.branch) return `${thread.projectId}:${thread.branch}`;
  // Local threads without a branch: group by project
  return thread.projectId;
}

/**
 * Fetch fresh git status for a thread and emit it via WebSocket.
 * Shared by the debounced git-changed handler, the agent-completed handler,
 * and agent-message-handler's emitGitStatus method.
 */
export async function emitGitStatusForThread(
  opts: {
    threadId: string;
    userId: string;
    worktreePath?: string | null;
    cwd?: string | null;
    /** Optional GH_TOKEN env for PR detection on private repos */
    ghEnv?: Record<string, string>;
    /**
     * Allow rewriting `thread.branch` to match the current checkout when they
     * diverge. Only safe when the caller has evidence that THIS thread's agent
     * just ran a checkout (e.g., a Bash tool call). With multiple local threads
     * sharing one working directory, blindly trusting the current branch lets
     * one thread's checkout corrupt sibling threads' branch identity.
     */
    detectBranchDrift?: boolean;
  },
  ctx: HandlerServiceContext,
): Promise<void> {
  const effectiveCwd = opts.worktreePath ?? opts.cwd;
  if (!effectiveCwd) return;

  const thread = await ctx.getThread(opts.threadId);
  if (!thread) return;

  const project = await ctx.getProject(thread.projectId);
  if (!project) return;

  // ── Branch drift detection (local-mode threads only) ──────────
  // Worktree threads have isolated directories — their branch is managed
  // by the worktree lifecycle, not by agent tool calls.
  if (!thread.worktreePath && opts.detectBranchDrift) {
    const branchResult = await getCurrentBranch(effectiveCwd);
    if (branchResult.isOk()) {
      const currentBranch = branchResult.value;
      if (currentBranch && currentBranch !== thread.branch) {
        await ctx.updateThread(opts.threadId, { branch: currentBranch });
        ctx.emitToUser(opts.userId, {
          type: 'thread:updated',
          threadId: opts.threadId,
          data: { branch: currentBranch },
        });
        ctx.log(`Branch changed for thread ${opts.threadId}: ${thread.branch} → ${currentBranch}`);
      }
    }
  }

  // Invalidate core-level cache so we get fresh data
  invalidateStatusCache(effectiveCwd);

  const branchForPR = thread.branch || thread.baseBranch;

  // Run git status + PR lookup in parallel
  const [summaryResult, prInfo] = await Promise.all([
    ctx.getGitStatusSummary(effectiveCwd, thread.baseBranch ?? undefined, project.path),
    branchForPR ? getPRForBranch(project.path, branchForPR, opts.ghEnv) : Promise.resolve(null),
  ]);

  if (summaryResult.isErr()) {
    ctx.log(
      `Failed to get git status for thread ${opts.threadId}: [${summaryResult.error.type}] ${summaryResult.error.message}`,
    );
    return;
  }

  const summary = summaryResult.value;

  // Invalidate the HTTP cache so subsequent fetches don't return stale data
  ctx.invalidateGitStatusCache(project.id);

  const branchKey = computeBranchKey(thread);

  ctx.emitToUser(opts.userId, {
    type: 'git:status',
    threadId: opts.threadId,
    data: {
      statuses: [
        {
          threadId: opts.threadId,
          branchKey,
          state: ctx.deriveGitSyncState(summary),
          ...summary,
          ...(prInfo
            ? { prNumber: prInfo.prNumber, prUrl: prInfo.prUrl, prState: prInfo.prState }
            : {}),
        },
      ],
    },
  });
}
