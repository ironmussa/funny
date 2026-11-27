import type { GitHubRepo } from '@funny/shared';

import { request } from './_core';

interface GitHubListParams {
  state?: string;
  sha?: string;
  page?: number;
  per_page?: number;
  sort?: string;
  /** GraphQL page cursor from the previous page (issues), instead of `page`. */
  cursor?: string;
}

/** Query string shared by the project-scoped, paginated GitHub list endpoints. */
function githubListQuery(projectId: string, params?: GitHubListParams): URLSearchParams {
  const p = new URLSearchParams({ projectId });
  for (const key of ['state', 'sha', 'page', 'per_page', 'sort', 'cursor'] as const) {
    const value = params?.[key];
    if (value) p.set(key, String(value));
  }
  return p;
}

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
  /** Starts the clone; its outcome arrives as `clone:progress` events with this id. */
  cloneRepo: (cloneUrl: string, destinationPath: string, name: string, cloneId: string) =>
    request<{ cloneId: string }>('/github/clone', {
      method: 'POST',
      body: JSON.stringify({ cloneUrl, destinationPath, name, cloneId }),
    }),
  githubIssues: (
    projectId: string,
    params?: { state?: string; page?: number; per_page?: number },
  ) => {
    const p = githubListQuery(projectId, params);
    return request<{
      issues: import('@funny/shared').GitHubIssue[];
      hasMore: boolean;
      owner: string;
      repo: string;
    }>(`/github/issues?${p.toString()}`);
  },

  githubIssuesEnriched: (
    projectId: string,
    params?: {
      state?: string;
      page?: number;
      per_page?: number;
      cursor?: string;
      sort?: string;
      labels?: string[];
      authors?: string[];
      assignees?: string[];
      milestones?: string[];
      types?: string[];
      /** `owner/number` of each project. */
      projects?: string[];
    },
    signal?: AbortSignal,
  ) => {
    const p = githubListQuery(projectId, params);
    for (const key of [
      'labels',
      'authors',
      'assignees',
      'milestones',
      'types',
      'projects',
    ] as const) {
      const values = params?.[key];
      if (values?.length) p.set(key, values.join(','));
    }
    return request<{
      issues: import('@funny/shared').EnrichedGitHubIssue[];
      hasMore: boolean;
      /** Pass back as `cursor` to load the next page. */
      nextCursor?: string | null;
      owner: string;
      repo: string;
    }>(`/github/issues-enriched?${p.toString()}`, { signal });
  },

  githubPRs: (
    projectId: string,
    params?: {
      state?: string;
      page?: number;
      per_page?: number;
      sort?: import('@funny/shared').PRSortKey;
      cursor?: string;
    },
    signal?: AbortSignal,
  ) => {
    const p = githubListQuery(projectId, params);
    return request<{
      prs: import('@funny/shared').GitHubPR[];
      hasMore: boolean;
      /** Pass back as `cursor` to load the next page. */
      nextCursor?: string | null;
      owner: string;
      repo: string;
    }>(`/github/prs?${p.toString()}`, { signal });
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
    signal?: AbortSignal,
  ) => {
    const p = githubListQuery(projectId, params);
    if (params.labels?.length) p.set('labels', params.labels.join(','));
    if (params.authors?.length) p.set('authors', params.authors.join(','));
    if (params.assignees?.length) p.set('assignees', params.assignees.join(','));
    if (params.reviewers?.length) p.set('reviewers', params.reviewers.join(','));
    return request<{
      prs: import('@funny/shared').GitHubPR[];
      hasMore: boolean;
      owner: string;
      repo: string;
    }>(`/github/prs-search?${p.toString()}`, { signal });
  },

  /** Labels + assignable users to populate the PR filter dropdowns. */
  githubPRFilterOptions: (projectId: string, signal?: AbortSignal) =>
    request<import('@funny/shared').PRFilterOptions>(
      `/github/pr-filter-options?projectId=${projectId}`,
      { signal },
    ),

  /** Labels, users, milestones, issue types and projects for the Issues filter dropdowns. */
  githubIssueFilterOptions: (projectId: string, signal?: AbortSignal) =>
    request<import('@funny/shared').IssueFilterOptions>(
      `/github/issue-filter-options?${new URLSearchParams({ projectId })}`,
      { signal },
    ),

  githubCommitAuthors: (
    projectId: string,
    params?: { sha?: string; page?: number; per_page?: number },
  ) => {
    const p = githubListQuery(projectId, params);
    return request<{
      authors: Array<{ sha: string; login: string | null; avatar_url: string }>;
    }>(`/github/commit-authors?${p.toString()}`);
  },

  githubPRDetail: (projectId: string, prNumber: number) =>
    request<import('@funny/shared').PRDetail>(
      `/github/pr-detail?projectId=${projectId}&prNumber=${prNumber}`,
    ),

  githubActionRuns: (projectId: string, params: { branch?: string | null; page?: number } = {}) => {
    const p = new URLSearchParams({ projectId });
    if (params.branch) p.set('branch', params.branch);
    if (params.page) p.set('page', String(params.page));
    return request<import('@funny/shared').ActionRunsPage>(`/github/actions/runs?${p}`);
  },

  githubActionJobs: (projectId: string, runId: number) =>
    request<{ jobs: import('@funny/shared').ActionJob[] }>(
      `/github/actions/jobs?${new URLSearchParams({ projectId, runId: String(runId) })}`,
    ),

  githubActionJobLog: (projectId: string, jobId: number) =>
    request<import('@funny/shared').ActionJobLog>(
      `/github/actions/job-log?${new URLSearchParams({ projectId, jobId: String(jobId) })}`,
    ),

  githubRerunFailedJobs: (projectId: string, runId: number) =>
    request<{ ok: boolean }>('/github/actions/rerun-failed', {
      method: 'POST',
      body: JSON.stringify({ projectId, runId }),
    }),

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

  /** Deletes the issues for good (GitHub allows it to repository admins only). */
  githubDeleteIssues: (projectId: string, issueNumbers: number[]) =>
    request<import('@funny/shared/contracts/github-issues').DeleteIssuesResult>(
      `/github/issues-delete`,
      { method: 'POST', body: JSON.stringify({ projectId, issueNumbers }) },
    ),

  /** Adds labels to the issues (GitHub makes a label the repository lacks). */
  githubAddIssueLabels: (projectId: string, issueNumbers: number[], labels: string[]) =>
    request<import('@funny/shared/contracts/github-issues').AddIssueLabelsResult>(
      `/github/issues-labels`,
      { method: 'POST', body: JSON.stringify({ projectId, issueNumbers, labels }) },
    ),

  githubIssue: (projectId: string, issueNumber: number) =>
    request<{ issue: import('@funny/shared').EnrichedGitHubIssue }>(
      `/github/issue?projectId=${projectId}&issueNumber=${issueNumber}`,
    ),

  /** The issue's comments and events (labels, mentions, closing), oldest first. */
  githubIssueTimeline: (projectId: string, issueNumber: number) =>
    request<{ items: import('@funny/shared').IssueTimelineItem[] }>(
      `/github/issue-timeline?projectId=${projectId}&issueNumber=${issueNumber}`,
    ),

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
