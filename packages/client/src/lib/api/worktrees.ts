import { request } from './_core';

export const worktreesApi = {
  listWorktrees: (projectId: string) =>
    request<
      Array<{
        path: string;
        /** Absent for a worktree with a detached HEAD. */
        branch?: string;
        commit: string;
        isMain: boolean;
        lastActivityMs?: number;
      }>
    >(`/worktrees?projectId=${projectId}`),
  previewWorktree: (projectId: string, branchName: string) =>
    request<{
      sanitizedBranchDir: string;
      branchName: string;
      worktreePath: string;
      alreadyExists: boolean;
    }>(
      `/worktrees/preview?projectId=${encodeURIComponent(projectId)}&branchName=${encodeURIComponent(branchName)}`,
    ),
  worktreeStatus: (projectId: string, worktreePath: string) =>
    request<{ unpushedCommitCount: number; dirtyFileCount: number; hasRemoteBranch: boolean }>(
      `/worktrees/status?projectId=${encodeURIComponent(projectId)}&worktreePath=${encodeURIComponent(worktreePath)}`,
    ),
  createWorktree: (data: { projectId: string; branchName: string; baseBranch?: string }) =>
    request<{ path: string; branch: string }>('/worktrees', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  removeWorktree: (
    projectId: string,
    worktreePath: string,
    options?: { branchName?: string; deleteBranch?: boolean },
  ) =>
    request<{ ok: boolean }>('/worktrees', {
      method: 'DELETE',
      body: JSON.stringify({
        projectId,
        worktreePath,
        branchName: options?.branchName,
        deleteBranch: options?.deleteBranch,
      }),
    }),
};
