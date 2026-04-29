import type { FileDiff, GitStatusInfo } from '@funny/shared';

import { request, type PullStrategy } from './_core';

export const gitApi = {
  // Thread-scoped git
  getDiff: (threadId: string) => request<FileDiff[]>(`/git/${threadId}/diff`),
  getDiffSummary: (
    threadId: string,
    excludePatterns?: string[],
    maxFiles?: number,
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams();
    if (excludePatterns?.length) params.set('exclude', excludePatterns.join(','));
    if (maxFiles) params.set('maxFiles', String(maxFiles));
    const qs = params.toString();
    return request<import('@funny/shared').DiffSummaryResponse>(
      `/git/${threadId}/diff/summary${qs ? `?${qs}` : ''}`,
      { signal },
    );
  },
  getFileDiff: (
    threadId: string,
    filePath: string,
    staged: boolean,
    signal?: AbortSignal,
    context?: 'full',
  ) =>
    request<{ diff: string }>(
      `/git/${threadId}/diff/file?path=${encodeURIComponent(filePath)}&staged=${staged}${context ? `&context=${context}` : ''}`,
      { signal },
    ),
  getSubmoduleDiffSummary: (threadId: string, submodulePath: string, signal?: AbortSignal) =>
    request<import('@funny/shared').DiffSummaryResponse>(
      `/git/${threadId}/diff/submodule?path=${encodeURIComponent(submodulePath)}`,
      { signal },
    ),
  getSubmoduleFileDiff: (
    threadId: string,
    submodulePath: string,
    filePath: string,
    staged: boolean,
    signal?: AbortSignal,
    context?: 'full',
  ) =>
    request<{ diff: string }>(
      `/git/${threadId}/diff/submodule/file?submodule=${encodeURIComponent(submodulePath)}&path=${encodeURIComponent(filePath)}&staged=${staged}${context ? `&context=${context}` : ''}`,
      { signal },
    ),
  stageFiles: (threadId: string, paths: string[]) =>
    request<{ ok: boolean }>(`/git/${threadId}/stage`, {
      method: 'POST',
      body: JSON.stringify({ paths }),
    }),
  unstageFiles: (threadId: string, paths: string[]) =>
    request<{ ok: boolean }>(`/git/${threadId}/unstage`, {
      method: 'POST',
      body: JSON.stringify({ paths }),
    }),
  stagePatch: (threadId: string, patch: string) =>
    request<{ ok: boolean }>(`/git/${threadId}/stage-patch`, {
      method: 'POST',
      body: JSON.stringify({ patch }),
    }),
  unstagePatch: (threadId: string, patch: string) =>
    request<{ ok: boolean }>(`/git/${threadId}/unstage-patch`, {
      method: 'POST',
      body: JSON.stringify({ patch }),
    }),
  revertFiles: (threadId: string, paths: string[]) =>
    request<{ ok: boolean }>(`/git/${threadId}/revert`, {
      method: 'POST',
      body: JSON.stringify({ paths }),
    }),
  resolveConflict: (
    threadId: string,
    filePath: string,
    blockIndex: number,
    resolution: 'ours' | 'theirs' | 'both',
  ) =>
    request<{ ok: boolean; remainingConflicts: number }>(`/git/${threadId}/conflict/resolve`, {
      method: 'POST',
      body: JSON.stringify({ filePath, blockIndex, resolution }),
    }),
  commit: (threadId: string, message: string, amend?: boolean, noVerify?: boolean) =>
    request<{ ok: boolean; output?: string }>(`/git/${threadId}/commit`, {
      method: 'POST',
      body: JSON.stringify({ message, amend, noVerify }),
    }),
  runHookCommand: (threadId: string, hookIndex: number) =>
    request<{ success: boolean; output: string }>(`/git/${threadId}/run-hook-command`, {
      method: 'POST',
      body: JSON.stringify({ hookIndex }),
    }),
  push: (threadId: string) =>
    request<{ ok: boolean; output?: string }>(`/git/${threadId}/push`, { method: 'POST' }),
  createPR: (threadId: string, title: string, body: string) =>
    request<{ ok: boolean; url?: string }>(`/git/${threadId}/pr`, {
      method: 'POST',
      body: JSON.stringify({ title, body }),
    }),
  merge: (threadId: string, opts?: { targetBranch?: string; push?: boolean; cleanup?: boolean }) =>
    request<{ ok: boolean; output?: string }>(`/git/${threadId}/merge`, {
      method: 'POST',
      body: JSON.stringify(opts ?? {}),
    }),
  generateCommitMessage: (threadId: string, includeUnstaged?: boolean, signal?: AbortSignal) =>
    request<{ title: string; body: string }>(`/git/${threadId}/generate-commit-message`, {
      method: 'POST',
      body: JSON.stringify({ includeUnstaged: includeUnstaged ?? false }),
      signal,
    }),
  addToGitignore: (threadId: string, pattern: string) =>
    request<{ ok: boolean }>(`/git/${threadId}/gitignore`, {
      method: 'POST',
      body: JSON.stringify({ pattern }),
    }),
  addPatternsToGitignore: (threadId: string, patterns: string[]) =>
    request<{ ok: boolean }>(`/git/${threadId}/gitignore`, {
      method: 'POST',
      body: JSON.stringify({ patterns }),
    }),
  getGitStatuses: (projectId: string, signal?: AbortSignal) =>
    request<{ statuses: GitStatusInfo[] }>(`/git/status?projectId=${projectId}`, { signal }),
  getGitStatus: (threadId: string, signal?: AbortSignal) =>
    request<GitStatusInfo>(`/git/${threadId}/status`, { signal }),
  getGitLog: (threadId: string, limit = 50, all = false, skip = 0, signal?: AbortSignal) =>
    request<{
      entries: Array<{
        hash: string;
        shortHash: string;
        author: string;
        authorEmail: string;
        relativeDate: string;
        message: string;
      }>;
      hasMore: boolean;
      unpushedHashes: string[];
    }>(
      `/git/${threadId}/log?limit=${limit}${all ? '&all=true' : ''}${skip > 0 ? `&skip=${skip}` : ''}`,
      { signal },
    ),
  getCommitFiles: (threadId: string, hash: string) =>
    request<{
      files: Array<{
        path: string;
        status: string;
        additions: number;
        deletions: number;
      }>;
    }>(`/git/${threadId}/commit/${hash}/files`),
  getCommitFileDiff: (threadId: string, hash: string, filePath: string) =>
    request<{ diff: string }>(
      `/git/${threadId}/commit/${hash}/diff?path=${encodeURIComponent(filePath)}`,
    ),
  getCommitBody: (threadId: string, hash: string) =>
    request<{ body: string }>(`/git/${threadId}/commit/${hash}/body`),
  pull: (threadId: string, strategy: PullStrategy = 'ff-only') =>
    request<{ ok: boolean; output?: string }>(`/git/${threadId}/pull`, {
      method: 'POST',
      body: JSON.stringify({ strategy }),
    }),
  fetchOrigin: (threadId: string) =>
    request<{ ok: boolean }>(`/git/${threadId}/fetch`, { method: 'POST' }),
  stash: (threadId: string, files?: string[]) =>
    request<{ ok: boolean; output?: string }>(`/git/${threadId}/stash`, {
      method: 'POST',
      ...(files?.length ? { body: JSON.stringify({ files }) } : {}),
    }),
  stashPop: (threadId: string) =>
    request<{ ok: boolean; output?: string }>(`/git/${threadId}/stash/pop`, { method: 'POST' }),
  stashList: (threadId: string, signal?: AbortSignal) =>
    request<{ entries: Array<{ index: string; message: string; relativeDate: string }> }>(
      `/git/${threadId}/stash/list`,
      { signal },
    ),
  stashShow: (threadId: string, stashIndex: string) =>
    request<{ files: Array<{ path: string; additions: number; deletions: number }> }>(
      `/git/${threadId}/stash/show/${stashIndex}`,
    ),
  stashFileDiff: (threadId: string, stashIndex: string, filePath: string) =>
    request<{ diff: string }>(
      `/git/${threadId}/stash/${stashIndex}/diff?path=${encodeURIComponent(filePath)}`,
    ),
  stashDrop: (threadId: string, stashIndex: string) =>
    request<{ ok: boolean; output?: string }>(`/git/${threadId}/stash/drop/${stashIndex}`, {
      method: 'POST',
    }),
  resetSoft: (threadId: string) =>
    request<{ ok: boolean; output?: string }>(`/git/${threadId}/reset-soft`, { method: 'POST' }),
  checkoutCommit: (threadId: string, hash: string) =>
    request<{ ok: boolean; output?: string }>(`/git/${threadId}/checkout-commit`, {
      method: 'POST',
      body: JSON.stringify({ hash }),
    }),
  revertCommit: (threadId: string, hash: string) =>
    request<{ ok: boolean; output?: string }>(`/git/${threadId}/revert-commit`, {
      method: 'POST',
      body: JSON.stringify({ hash }),
    }),
  resetHard: (threadId: string, hash: string) =>
    request<{ ok: boolean; output?: string }>(`/git/${threadId}/reset-hard`, {
      method: 'POST',
      body: JSON.stringify({ hash }),
    }),

  // Project-scoped git (no thread — operates on the project's main directory)
  projectGitStatus: (projectId: string, signal?: AbortSignal) =>
    request<Omit<import('@funny/shared').GitStatusInfo, 'threadId'>>(
      `/git/project/${projectId}/status`,
      { signal },
    ),
  projectDiffSummary: (
    projectId: string,
    excludePatterns?: string[],
    maxFiles?: number,
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams();
    if (excludePatterns?.length) params.set('exclude', excludePatterns.join(','));
    if (maxFiles) params.set('maxFiles', String(maxFiles));
    const qs = params.toString();
    return request<import('@funny/shared').DiffSummaryResponse>(
      `/git/project/${projectId}/diff/summary${qs ? `?${qs}` : ''}`,
      { signal },
    );
  },
  projectFileDiff: (
    projectId: string,
    filePath: string,
    staged: boolean,
    signal?: AbortSignal,
    context?: 'full',
  ) =>
    request<{ diff: string }>(
      `/git/project/${projectId}/diff/file?path=${encodeURIComponent(filePath)}&staged=${staged}${context ? `&context=${context}` : ''}`,
      { signal },
    ),
  projectSubmoduleDiffSummary: (projectId: string, submodulePath: string, signal?: AbortSignal) =>
    request<import('@funny/shared').DiffSummaryResponse>(
      `/git/project/${projectId}/diff/submodule?path=${encodeURIComponent(submodulePath)}`,
      { signal },
    ),
  projectSubmoduleFileDiff: (
    projectId: string,
    submodulePath: string,
    filePath: string,
    staged: boolean,
    signal?: AbortSignal,
    context?: 'full',
  ) =>
    request<{ diff: string }>(
      `/git/project/${projectId}/diff/submodule/file?submodule=${encodeURIComponent(submodulePath)}&path=${encodeURIComponent(filePath)}&staged=${staged}${context ? `&context=${context}` : ''}`,
      { signal },
    ),
  projectStageFiles: (projectId: string, paths: string[]) =>
    request<{ ok: boolean }>(`/git/project/${projectId}/stage`, {
      method: 'POST',
      body: JSON.stringify({ paths }),
    }),
  projectUnstageFiles: (projectId: string, paths: string[]) =>
    request<{ ok: boolean }>(`/git/project/${projectId}/unstage`, {
      method: 'POST',
      body: JSON.stringify({ paths }),
    }),
  projectStagePatch: (projectId: string, patch: string) =>
    request<{ ok: boolean }>(`/git/project/${projectId}/stage-patch`, {
      method: 'POST',
      body: JSON.stringify({ patch }),
    }),
  projectUnstagePatch: (projectId: string, patch: string) =>
    request<{ ok: boolean }>(`/git/project/${projectId}/unstage-patch`, {
      method: 'POST',
      body: JSON.stringify({ patch }),
    }),
  projectRevertFiles: (projectId: string, paths: string[]) =>
    request<{ ok: boolean }>(`/git/project/${projectId}/revert`, {
      method: 'POST',
      body: JSON.stringify({ paths }),
    }),
  projectResolveConflict: (
    projectId: string,
    filePath: string,
    blockIndex: number,
    resolution: 'ours' | 'theirs' | 'both',
  ) =>
    request<{ ok: boolean; remainingConflicts: number }>(
      `/git/project/${projectId}/conflict/resolve`,
      {
        method: 'POST',
        body: JSON.stringify({ filePath, blockIndex, resolution }),
      },
    ),
  projectCommit: (projectId: string, message: string, amend?: boolean, noVerify?: boolean) =>
    request<{ ok: boolean; output?: string }>(`/git/project/${projectId}/commit`, {
      method: 'POST',
      body: JSON.stringify({ message, amend, noVerify }),
    }),
  projectRunHookCommand: (projectId: string, hookIndex: number) =>
    request<{ success: boolean; output: string }>(`/git/project/${projectId}/run-hook-command`, {
      method: 'POST',
      body: JSON.stringify({ hookIndex }),
    }),
  projectGetRemoteUrl: (projectId: string, signal?: AbortSignal) =>
    request<{ remoteUrl: string | null }>(`/git/project/${projectId}/remote-url`, { signal }),
  projectSetRemoteUrl: (projectId: string, url: string) =>
    request<{ ok: boolean }>(`/git/project/${projectId}/remote`, {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),
  projectGetGhOrgs: (projectId: string, signal?: AbortSignal) =>
    request<{ orgs: string[] }>(`/git/project/${projectId}/gh-orgs`, { signal }),
  projectPublish: (
    projectId: string,
    params: { name: string; description?: string; org?: string; private: boolean },
  ) =>
    request<{ ok: boolean; repoUrl: string }>(`/git/project/${projectId}/publish`, {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  projectPush: (projectId: string) =>
    request<{ ok: boolean; output?: string }>(`/git/project/${projectId}/push`, { method: 'POST' }),
  projectPull: (projectId: string, strategy: PullStrategy = 'ff-only') =>
    request<{ ok: boolean; output?: string }>(`/git/project/${projectId}/pull`, {
      method: 'POST',
      body: JSON.stringify({ strategy }),
    }),
  projectFetchOrigin: (projectId: string) =>
    request<{ ok: boolean }>(`/git/project/${projectId}/fetch`, { method: 'POST' }),
  projectStash: (projectId: string, files?: string[]) =>
    request<{ ok: boolean; output?: string }>(`/git/project/${projectId}/stash`, {
      method: 'POST',
      ...(files?.length ? { body: JSON.stringify({ files }) } : {}),
    }),
  projectStashPop: (projectId: string) =>
    request<{ ok: boolean; output?: string }>(`/git/project/${projectId}/stash/pop`, {
      method: 'POST',
    }),
  projectStashList: (projectId: string, signal?: AbortSignal) =>
    request<{ entries: Array<{ index: string; message: string; relativeDate: string }> }>(
      `/git/project/${projectId}/stash/list`,
      { signal },
    ),
  projectStashShow: (projectId: string, stashIndex: string) =>
    request<{ files: Array<{ path: string; additions: number; deletions: number }> }>(
      `/git/project/${projectId}/stash/show/${stashIndex}`,
    ),
  projectStashFileDiff: (projectId: string, stashIndex: string, filePath: string) =>
    request<{ diff: string }>(
      `/git/project/${projectId}/stash/${stashIndex}/diff?path=${encodeURIComponent(filePath)}`,
    ),
  projectStashDrop: (projectId: string, stashIndex: string) =>
    request<{ ok: boolean; output?: string }>(
      `/git/project/${projectId}/stash/drop/${stashIndex}`,
      { method: 'POST' },
    ),
  projectResetSoft: (projectId: string) =>
    request<{ ok: boolean; output?: string }>(`/git/project/${projectId}/reset-soft`, {
      method: 'POST',
    }),
  projectCheckoutCommit: (projectId: string, hash: string) =>
    request<{ ok: boolean; output?: string }>(`/git/project/${projectId}/checkout-commit`, {
      method: 'POST',
      body: JSON.stringify({ hash }),
    }),
  projectRevertCommit: (projectId: string, hash: string) =>
    request<{ ok: boolean; output?: string }>(`/git/project/${projectId}/revert-commit`, {
      method: 'POST',
      body: JSON.stringify({ hash }),
    }),
  projectResetHard: (projectId: string, hash: string) =>
    request<{ ok: boolean; output?: string }>(`/git/project/${projectId}/reset-hard`, {
      method: 'POST',
      body: JSON.stringify({ hash }),
    }),
  projectGitLog: (projectId: string, limit = 50, skip = 0, signal?: AbortSignal) =>
    request<{
      entries: Array<{
        hash: string;
        shortHash: string;
        author: string;
        authorEmail: string;
        relativeDate: string;
        message: string;
      }>;
      hasMore: boolean;
      unpushedHashes: string[];
    }>(`/git/project/${projectId}/log?limit=${limit}${skip > 0 ? `&skip=${skip}` : ''}`, {
      signal,
    }),
  projectCommitFiles: (projectId: string, hash: string) =>
    request<{
      files: Array<{
        path: string;
        status: string;
        additions: number;
        deletions: number;
      }>;
    }>(`/git/project/${projectId}/commit/${hash}/files`),
  projectCommitFileDiff: (projectId: string, hash: string, filePath: string) =>
    request<{ diff: string }>(
      `/git/project/${projectId}/commit/${hash}/diff?path=${encodeURIComponent(filePath)}`,
    ),
  projectCommitBody: (projectId: string, hash: string) =>
    request<{ body: string }>(`/git/project/${projectId}/commit/${hash}/body`),
  projectGenerateCommitMessage: (
    projectId: string,
    includeUnstaged?: boolean,
    signal?: AbortSignal,
  ) =>
    request<{ title: string; body: string }>(`/git/project/${projectId}/generate-commit-message`, {
      method: 'POST',
      body: JSON.stringify({ includeUnstaged: includeUnstaged ?? false }),
      signal,
    }),
  projectAddToGitignore: (projectId: string, pattern: string) =>
    request<{ ok: boolean }>(`/git/project/${projectId}/gitignore`, {
      method: 'POST',
      body: JSON.stringify({ pattern }),
    }),
  projectAddPatternsToGitignore: (projectId: string, patterns: string[]) =>
    request<{ ok: boolean }>(`/git/project/${projectId}/gitignore`, {
      method: 'POST',
      body: JSON.stringify({ patterns }),
    }),

  // Git Workflow (server-side orchestration)
  startWorkflow: (threadId: string, params: import('@funny/shared').GitWorkflowRequest) =>
    request<{ workflowId: string }>(`/git/${threadId}/workflow`, {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  projectStartWorkflow: (projectId: string, params: import('@funny/shared').GitWorkflowRequest) =>
    request<{ workflowId: string }>(`/git/project/${projectId}/workflow`, {
      method: 'POST',
      body: JSON.stringify(params),
    }),
};
