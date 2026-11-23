/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 * @domain depends: RunnerAccess, ServerActivities
 *
 * The server asks a thread's runner to remove the thread's workspace
 * (track-funny-actions, design D8): after an archive, a delete or a merged
 * factory run. The worktree path and branch come from the server's own thread
 * row, never from the browser (security CR-4); the runner re-validates the
 * path against `git worktree list` and records the cleanup itself.
 *
 * The request goes only to the runner the thread runs on, certified for the
 * thread's owner (`sendToThreadRunner` → `withRunnerFor`). When that runner
 * cannot be reached, the server records the failed cleanup itself, naming
 * the directory left on disk; it never asks another runner.
 */

import type { ActivityOrigin, Thread } from '@funny/shared';
import type { WorkspaceCleanupReason } from '@funny/shared/activities';
import { eq } from 'drizzle-orm';
import { err, ok, type Result } from 'neverthrow';

import { db } from '../db/index.js';
import { threads } from '../db/schema.js';
import { log } from '../lib/logger.js';
import { recordServerActivity } from './activities/server-activities.js';
import type { BrowserEventSink } from './runner-ports.js';
import type { RunnerPorts } from './runner-thread-launcher.js';
import { sendToThreadRunner } from './thread-runner-requests.js';

export interface ThreadWorkspace {
  id: string;
  projectId: string;
  worktreePath: string;
  branch: string | null;
}

export interface ThreadWorkspaceCleanupRequest {
  /** The thread's owner, read from the thread row. */
  userId: string;
  thread: ThreadWorkspace;
  deleteBranch: boolean;
  reason: WorkspaceCleanupReason;
  origin?: ActivityOrigin;
}

function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path;
}

/**
 * Asks the thread's runner to remove its worktree (and branch when
 * `deleteBranch`). Resolves `err` with the reason when it was not removed.
 */
export async function requestThreadWorkspaceCleanup(
  ports: RunnerPorts,
  request: ThreadWorkspaceCleanupRequest,
): Promise<Result<void, string>> {
  const { userId, thread, deleteBranch, reason } = request;
  const origin = request.origin ?? 'implicit';
  const sent = await sendToThreadRunner(ports, userId, {
    method: 'DELETE',
    path: '/api/worktrees',
    query: { threadId: thread.id, projectId: thread.projectId },
    body: {
      projectId: thread.projectId,
      worktreePath: thread.worktreePath,
      branchName: thread.branch ?? undefined,
      deleteBranch: deleteBranch && !!thread.branch,
      reason,
      threadId: thread.id,
    },
  });
  if (sent.isOk()) return ok(undefined);

  // Unless the runner says it recorded the failed cleanup, the server does:
  // an unreachable runner, or one that refused before the cleanup ran.
  if (!sent.error.activityRecorded) {
    await recordServerActivity(
      {
        kind: 'workspace.cleanup',
        userId,
        projectId: thread.projectId,
        threadId: thread.id,
        title: `Clean up worktree ${basename(thread.worktreePath)}`,
        input: {
          reason,
          branch: thread.branch || undefined,
          deleteBranch: deleteBranch && !!thread.branch,
        },
        origin,
      },
      {
        ok: false,
        error: `The worktree was not removed and is still at ${thread.worktreePath}: ${sent.error.message}. Remove it from the project's worktree settings once the runner is connected.`,
      },
    );
  }
  log.warn('Thread workspace cleanup failed', {
    namespace: 'thread-workspace-cleanup',
    threadId: thread.id,
    reason,
    answered: sent.error.answered,
    error: sent.error.message,
  });
  return err(sent.error.message);
}

/** Asks the runner to remove a deleted scratch thread's directory. */
export async function requestScratchCleanup(
  ports: RunnerPorts,
  request: { userId: string; threadId: string },
): Promise<Result<void, string>> {
  const sent = await sendToThreadRunner(ports, request.userId, {
    method: 'DELETE',
    path: `/api/threads/${encodeURIComponent(request.threadId)}/scratch`,
    body: null,
  });
  if (sent.isOk()) return ok(undefined);
  if (!sent.error.activityRecorded) {
    await recordServerActivity(
      {
        kind: 'workspace.cleanup',
        userId: request.userId,
        threadId: request.threadId,
        title: 'Remove scratch directory',
        input: { reason: 'thread-deleted', deleteBranch: false },
        origin: 'implicit',
      },
      {
        ok: false,
        error: `The scratch directory was not removed: ${sent.error.message}.`,
      },
    );
  }
  log.warn('Scratch cleanup failed', {
    namespace: 'thread-workspace-cleanup',
    threadId: request.threadId,
    error: sent.error.message,
  });
  return err(sent.error.message);
}

async function stillArchived(threadId: string): Promise<boolean> {
  const [row] = await db
    .select({ archived: threads.archived })
    .from(threads)
    .where(eq(threads.id, threadId));
  return !!row?.archived;
}

/** After a successful removal the thread no longer names a worktree or a branch. */
export async function clearThreadWorkspace(threadId: string): Promise<void> {
  await db
    .update(threads)
    .set({ worktreePath: null, branch: null })
    .where(eq(threads.id, threadId));
}

/** Statuses in which a thread's agent or setup may still use its worktree. */
const ACTIVE_STATUSES = new Set(['running', 'waiting', 'pending', 'setting_up']);

/**
 * The thread's workspace to remove when it is archived (design D8), or null:
 * only an idle worktree thread funny created on a local runner. A sandbox is
 * torn down with its own lifecycle, an external provider's checkout is not
 * ours, and a running thread keeps its checkout.
 */
type WorkspaceThread = Pick<
  Thread,
  'id' | 'projectId' | 'mode' | 'runtime' | 'provider' | 'status' | 'isScratch'
> & { worktreePath?: string | null; branch?: string | null };

export function workspaceToRemoveOnArchive(thread: WorkspaceThread): ThreadWorkspace | null {
  if (ACTIVE_STATUSES.has(thread.status)) return null;
  return workspaceToRemoveOnDelete(thread);
}

/**
 * The workspace to remove when the thread is deleted: the same rule as an
 * archive, whatever the status (the thread is gone either way).
 */
export function workspaceToRemoveOnDelete(thread: WorkspaceThread): ThreadWorkspace | null {
  if (thread.isScratch || !thread.projectId) return null;
  if (thread.mode !== 'worktree' || !thread.worktreePath) return null;
  if (thread.runtime === 'sandbox' || thread.provider === 'external') return null;
  return {
    id: thread.id,
    projectId: thread.projectId,
    worktreePath: thread.worktreePath,
    branch: thread.branch ?? null,
  };
}

/**
 * Whether deleting the thread removes a scratch directory on its runner.
 * Truthy, not `=== true`: route handlers hold the stored row (`is_scratch` 1).
 */
export function removesScratchOnDelete(thread: Pick<Thread, 'isScratch'>): boolean {
  return Boolean(thread.isScratch);
}

/**
 * Removes an archived thread's worktree and branch for its owner; on success
 * the row stops naming them and the owner's browsers are told. A failure
 * leaves the row as it is (the failed cleanup is recorded).
 */
export async function cleanUpArchivedThread(
  ports: RunnerPorts,
  ownerId: string,
  workspace: ThreadWorkspace,
  browserEvents?: BrowserEventSink,
): Promise<void> {
  // Unarchived before the background cleanup started: keep the workspace.
  if (!(await stillArchived(workspace.id))) return;
  const removed = await requestThreadWorkspaceCleanup(ports, {
    userId: ownerId,
    thread: workspace,
    deleteBranch: !!workspace.branch,
    reason: 'thread-archived',
  });
  if (removed.isErr()) return;
  await clearThreadWorkspace(workspace.id);
  browserEvents?.toUser(ownerId, {
    type: 'thread:updated',
    threadId: workspace.id,
    data: { worktreePath: null, branch: null },
  });
}
