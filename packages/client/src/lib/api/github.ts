import type { GitHubRepo, Project } from '@funny/shared';

import { request } from './_core';

export const githubApi = {
  githubStatus: () =>
    request<{ connected: boolean; login?: string; source?: 'profile' | 'cli' }>('/github/status'),
  githubStartDevice: () =>
    request<{
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    }>('/github/oauth/device', { method: 'POST' }),
  githubPoll: (deviceCode: string) =>
    request<{
      status: 'pending' | 'success' | 'expired' | 'denied';
      scopes?: string;
      interval?: number;
    }>('/github/oauth/poll', { method: 'POST', body: JSON.stringify({ deviceCode }) }),
  githubDisconnect: () =>
    request<{ ok: boolean }>('/github/oauth/disconnect', { method: 'DELETE' }),
  githubUser: () =>
    request<{ login: string; avatar_url: string; name: string | null }>('/github/user'),
  githubRepos: (params?: { page?: number; per_page?: number; search?: string; sort?: string }) => {
    const p = new URLSearchParams();
    if (params?.page) p.set('page', String(params.page));
    if (params?.per_page) p.set('per_page', String(params.per_page));
    if (params?.search) p.set('search', params.search);
    if (params?.sort) p.set('sort', params.sort);
    const qs = p.toString();
    return request<{ repos: GitHubRepo[]; hasMore: boolean }>(`/github/repos${qs ? `?${qs}` : ''}`);
  },
  cloneRepo: (cloneUrl: string, destinationPath: string, name?: string) =>
    request<Project>('/github/clone', {
      method: 'POST',
      body: JSON.stringify({ cloneUrl, destinationPath, name }),
    }),
  githubIssues: (
    projectId: string,
    params?: { state?: string; page?: number; per_page?: number },
  ) => {
    const p = new URLSearchParams({ projectId });
    if (params?.state) p.set('state', params.state);
    if (params?.page) p.set('page', String(params.page));
    if (params?.per_page) p.set('per_page', String(params.per_page));
    return request<{
      issues: import('@funny/shared').GitHubIssue[];
      hasMore: boolean;
      owner: string;
      repo: string;
    }>(`/github/issues?${p.toString()}`);
  },

  githubIssuesEnriched: (
    projectId: string,
    params?: { state?: string; page?: number; per_page?: number },
  ) => {
    const p = new URLSearchParams({ projectId });
    if (params?.state) p.set('state', params.state);
    if (params?.page) p.set('page', String(params.page));
    if (params?.per_page) p.set('per_page', String(params.per_page));
    return request<{
      issues: import('@funny/shared').EnrichedGitHubIssue[];
      hasMore: boolean;
      owner: string;
      repo: string;
    }>(`/github/issues-enriched?${p.toString()}`);
  },

  githubPRs: (
    projectId: string,
    params?: {
      state?: string;
      page?: number;
      per_page?: number;
      sort?: import('@funny/shared').PRSortKey;
    },
  ) => {
    const p = new URLSearchParams({ projectId });
    if (params?.state) p.set('state', params.state);
    if (params?.page) p.set('page', String(params.page));
    if (params?.per_page) p.set('per_page', String(params.per_page));
    if (params?.sort) p.set('sort', params.sort);
    return request<{
      prs: import('@funny/shared').GitHubPR[];
      hasMore: boolean;
      owner: string;
      repo: string;
    }>(`/github/prs?${p.toString()}`);
  },

  /** Filter PRs across the whole repo via the GitHub Search API (server-side). */
  githubPRsSearch: (
    projectId: string,
    params: {
      state?: string;
      page?: number;
      per_page?: number;
      sort?: import('@funny/shared').PRSortKey;
      labels?: string[];
      authors?: string[];
      assignees?: string[];
      reviewers?: string[];
    },
  ) => {
    const p = new URLSearchParams({ projectId });
    if (params.state) p.set('state', params.state);
    if (params.page) p.set('page', String(params.page));
    if (params.per_page) p.set('per_page', String(params.per_page));
    if (params.sort) p.set('sort', params.sort);
    if (params.labels?.length) p.set('labels', params.labels.join(','));
    if (params.authors?.length) p.set('authors', params.authors.join(','));
    if (params.assignees?.length) p.set('assignees', params.assignees.join(','));
    if (params.reviewers?.length) p.set('reviewers', params.reviewers.join(','));
    return request<{
      prs: import('@funny/shared').GitHubPR[];
      hasMore: boolean;
      owner: string;
      repo: string;
    }>(`/github/prs-search?${p.toString()}`);
  },

  /** Labels + assignable users to populate the PR filter dropdowns. */
  githubPRFilterOptions: (projectId: string) =>
    request<import('@funny/shared').PRFilterOptions>(
      `/github/pr-filter-options?projectId=${projectId}`,
    ),

  githubCommitAuthors: (
    projectId: string,
    params?: { sha?: string; page?: number; per_page?: number },
  ) => {
    const p = new URLSearchParams({ projectId });
    if (params?.sha) p.set('sha', params.sha);
    if (params?.page) p.set('page', String(params.page));
    if (params?.per_page) p.set('per_page', String(params.per_page));
    return request<{
      authors: Array<{ sha: string; login: string | null; avatar_url: string }>;
    }>(`/github/commit-authors?${p.toString()}`);
  },

  githubPRDetail: (projectId: string, prNumber: number) =>
    request<import('@funny/shared').PRDetail>(
      `/github/pr-detail?projectId=${projectId}&prNumber=${prNumber}`,
    ),

  githubPRThreads: (projectId: string, prNumber: number) =>
    request<{ threads: import('@funny/shared').PRReviewThread[] }>(
      `/github/pr-threads?projectId=${projectId}&prNumber=${prNumber}`,
    ),

  githubPRMerge: (
    projectId: string,
    prNumber: number,
    method: 'squash' | 'merge' | 'rebase' = 'squash',
  ) =>
    request<{ merged: boolean; sha: string; message: string }>(`/github/pr-merge`, {
      method: 'POST',
      body: JSON.stringify({ projectId, prNumber, method }),
    }),

  githubPRConversation: (projectId: string, prNumber: number) =>
    request<import('@funny/shared').PRConversation>(
      `/github/pr-conversation?projectId=${projectId}&prNumber=${prNumber}`,
    ),

  githubPRCommentCreate: (projectId: string, prNumber: number, body: string) =>
    request<import('@funny/shared').PRIssueComment>(`/github/pr-comment`, {
      method: 'POST',
      body: JSON.stringify({ projectId, prNumber, body }),
    }),

  githubPRReviewReply: (projectId: string, prNumber: number, commentId: number, body: string) =>
    request<import('@funny/shared').PRThreadComment>(`/github/pr-review-reply`, {
      method: 'POST',
      body: JSON.stringify({ projectId, prNumber, commentId, body }),
    }),

  githubPRThreadResolve: (projectId: string, threadNodeId: string, resolve: boolean) =>
    request<{ node_id: string; is_resolved: boolean }>(`/github/pr-thread-resolve`, {
      method: 'POST',
      body: JSON.stringify({ projectId, threadNodeId, resolve }),
    }),

  githubPRReaction: (
    projectId: string,
    kind: import('@funny/shared').PRCommentKind,
    commentId: number,
    content: import('@funny/shared').PRReactionContent,
  ) =>
    request<{ id: number; content: string }>(`/github/pr-reaction`, {
      method: 'POST',
      body: JSON.stringify({ projectId, kind, commentId, content }),
    }),

  githubPRCommentEdit: (
    projectId: string,
    kind: import('@funny/shared').PRCommentKind,
    commentId: number,
    body: string,
  ) =>
    request<{
      id: number;
      body: string;
      updated_at: string;
      reactions: import('@funny/shared').PRReactionSummary;
    }>(`/github/pr-comment`, {
      method: 'PATCH',
      body: JSON.stringify({ projectId, kind, commentId, body }),
    }),

  githubPRCommentDelete: (
    projectId: string,
    kind: import('@funny/shared').PRCommentKind,
    commentId: number,
  ) => {
    const p = new URLSearchParams({
      projectId,
      kind,
      commentId: String(commentId),
    });
    return request<{ ok: boolean }>(`/github/pr-comment?${p.toString()}`, { method: 'DELETE' });
  },

  // GitHub PR files & commits
  githubPRFiles: (projectId: string, prNumber: number, commitSha?: string) => {
    const p = new URLSearchParams({ projectId, prNumber: String(prNumber) });
    if (commitSha) p.set('commitSha', commitSha);
    return request<{ files: import('@funny/shared').PRFile[] }>(`/github/pr-files?${p.toString()}`);
  },
  githubPRCommits: (projectId: string, prNumber: number) =>
    request<{ commits: import('@funny/shared').PRCommit[] }>(
      `/github/pr-commits?projectId=${projectId}&prNumber=${prNumber}`,
    ),
  githubPRRevertFile: (projectId: string, prNumber: number, filePath: string) =>
    request<{ ok: boolean; action: 'reverted' | 'deleted' }>('/github/pr-revert-file', {
      method: 'POST',
      body: JSON.stringify({ projectId, prNumber, filePath }),
    }),
  githubPRFileContent: (projectId: string, prNumber: number, filePath: string) => {
    const p = new URLSearchParams({ projectId, prNumber: String(prNumber), filePath });
    return request<{ baseContent: string; headContent: string }>(
      `/github/pr-file-content?${p.toString()}`,
    );
  },
};
