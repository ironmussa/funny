import type { GitStatusInfo } from '@funny/shared';

import { runsInSandbox } from '@/lib/thread-variant';

/**
 * Pure git-status keys and comparisons, shared by the collections, the hooks
 * and the views. No state lives here.
 */

/** Git status for a project root (no threadId). */
export type ProjectGitStatus = Omit<GitStatusInfo, 'threadId' | 'branchKey'>;

/** The two lookups views join: status by branch key, branch key by thread. */
export interface GitStatusMaps {
  statusByBranch: Record<string, GitStatusInfo>;
  threadToBranchKey: Record<string, string>;
}

/**
 * Compute a stable cache key that groups threads sharing the same git working state.
 * Matches the server-side `computeBranchKey` logic.
 */
export function branchKey(thread: {
  id: string;
  projectId: string;
  mode?: string | null;
  branch?: string | null;
  worktreePath?: string | null;
  baseBranch?: string | null;
  runtime?: string | null;
}): string {
  // Sandbox threads: unique per thread — their checkout is on the sandbox
  // runner, never the project directory the local threads share.
  if (runsInSandbox(thread)) return `sb:${thread.id}`;
  // Worktree threads: always unique per thread — each worktree has its own
  // working directory so even threads on the same branch have independent state.
  // Use `mode` as the primary signal (worktreePath may be null if the worktree
  // was cleaned up but the thread hasn't been archived yet).
  if (thread.mode === 'worktree' && thread.branch)
    return `wt:${thread.projectId}:${thread.branch}:${thread.id}`;
  // Local threads with a branch: group by project + branch (they share the project cwd)
  if (thread.branch) return `${thread.projectId}:${thread.branch}`;
  // Local threads without a branch: group by project.
  // This covers both active local threads (branch=null) and merged threads —
  // the server resolves the correct branchKey per thread and the client picks
  // it up from the server response via threadToBranchKey mapping.
  return thread.projectId;
}

export function statusBranchKeyForThread(
  thread: {
    id: string;
    projectId: string;
    mode?: string | null;
    branch?: string | null;
    worktreePath?: string | null;
    baseBranch?: string | null;
    runtime?: string | null;
  },
  mapping: Record<string, string>,
): string {
  return mapping[thread.id] ?? branchKey(thread);
}

export function gitStatusForThreadFromState(
  state: GitStatusMaps,
  thread: {
    id: string;
    projectId: string;
    mode?: string | null;
    branch?: string | null;
    worktreePath?: string | null;
    baseBranch?: string | null;
    runtime?: string | null;
  },
): GitStatusInfo | undefined {
  return state.statusByBranch[statusBranchKeyForThread(thread, state.threadToBranchKey)];
}

/** Compare two GitStatusInfo objects for equality on the fields that affect rendering */
export function statusEqual(a: GitStatusInfo, b: GitStatusInfo): boolean {
  return (
    a.state === b.state &&
    a.dirtyFileCount === b.dirtyFileCount &&
    a.unpushedCommitCount === b.unpushedCommitCount &&
    a.unpulledCommitCount === b.unpulledCommitCount &&
    a.hasRemoteBranch === b.hasRemoteBranch &&
    a.isMergedIntoBase === b.isMergedIntoBase &&
    a.linesAdded === b.linesAdded &&
    a.linesDeleted === b.linesDeleted &&
    a.prNumber === b.prNumber &&
    a.prState === b.prState &&
    a.prUrl === b.prUrl
  );
}

/** Fields from a git status that affect sidebar thread rendering. */
export function gitStatusSidebarFingerprint(threadId: string, status: GitStatusInfo): string {
  return [
    threadId,
    status.state,
    status.dirtyFileCount,
    status.unpushedCommitCount,
    status.unpulledCommitCount,
    status.hasRemoteBranch,
    status.isMergedIntoBase,
    status.linesAdded,
    status.linesDeleted,
    status.prNumber ?? '',
    status.prState ?? '',
    status.prUrl ?? '',
  ].join(':');
}
