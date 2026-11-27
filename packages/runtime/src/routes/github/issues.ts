import { listBranches } from '@funny/core/git';
import type { EnrichedGitHubIssue, GitHubIssue } from '@funny/shared';
import { Hono } from 'hono';

import { log } from '../../lib/logger.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { fetchIssue, fetchRepoIssues, githubRepoFor, resolveGithubToken } from './helpers.js';
import { fetchIssueFilterOptions } from './issue-filter-options.js';
import { type IssueFilters, issueRestSort, readIssueFilters } from './issue-filters.js';
import { linkIssues, type LinkablePR } from './issue-links.js';
import { fetchIssueTimeline } from './issue-timeline.js';
import { fetchIssuesWithLinks, issueSearchQuery } from './issues-graphql.js';
import { type GithubListContext, readGithubListContext } from './list-context.js';
import { positiveIntParam } from './query.js';

export const issueRoutes = new Hono<HonoEnv>();

// ── GET /issues — list GitHub issues for a project ──────

issueRoutes.get('/issues', async (c) => {
  const list = await readGithubListContext(c);
  if (!list.ok) return list.response;
  const { userId, owner, repo, state, page, perPage } = list.ctx;

  try {
    const resolved = await resolveGithubToken(userId);
    const token = resolved?.token ?? null;

    const result = await fetchRepoIssues(owner, repo, { state, page, perPage, token });
    if (!result) {
      return c.json({ error: 'GitHub API error' }, 502);
    }

    return c.json({ issues: result.issues, hasMore: result.hasMore, owner, repo });
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
});

// ── GET /issues-enriched — issues with linked branch/PR detection ──────

/** Generate a branch name suggestion from an issue number and title. */
function suggestBranchName(number: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '');
  return `issue-${number}-${slug}`;
}

/**
 * With a token, one GraphQL request brings the issues and their PRs. GraphQL
 * needs authentication, so without one fall back to the anonymous REST search
 * (public repos only) and show no PR badges.
 */
async function loadIssuesPage(ctx: GithubListContext, token: string | null, filters: IssueFilters) {
  const { owner, repo, state, page, perPage, cursor } = ctx;
  if (token) return fetchIssuesWithLinks(owner, repo, { state, perPage, cursor, token, filters });
  const rest = await fetchRepoIssues(owner, repo, {
    state,
    page,
    perPage,
    token: null,
    search: {
      query: issueSearchQuery(owner, repo, state, filters),
      ...issueRestSort(filters.sort),
    },
  });
  if (!rest) return null;
  const pullRequests: LinkablePR[] = [];
  return { ...rest, pullRequests, nextCursor: null };
}

issueRoutes.get('/issues-enriched', async (c) => {
  const list = await readGithubListContext(c);
  if (!list.ok) return list.response;
  const { userId, projectPath, owner, repo } = list.ctx;

  try {
    const resolved = await resolveGithubToken(userId);
    const [issuesData, branchesResult] = await Promise.all([
      loadIssuesPage(list.ctx, resolved?.token ?? null, readIssueFilters(c)),
      listBranches(projectPath),
    ]);
    if (!issuesData) {
      return c.json({ error: 'Failed to fetch issues' }, 502);
    }

    const issues = linkIssues(issuesData.issues, {
      branches: branchesResult.unwrapOr([]),
      pullRequests: issuesData.pullRequests,
      repo: `${owner}/${repo}`,
      suggestBranchName: (issue) => suggestBranchName(issue.number, issue.title),
    });

    return c.json({
      issues,
      hasMore: issuesData.hasMore,
      nextCursor: issuesData.nextCursor,
      owner,
      repo,
    });
  } catch (error: any) {
    log.warn('failed to load issues', {
      namespace: 'github-issues',
      repo: `${owner}/${repo}`,
      error: error?.message,
    });
    return c.json({ error: error.message }, 502);
  }
});

// ── GET /issue-filter-options — what the Issues filter dropdowns offer ──────

issueRoutes.get('/issue-filter-options', async (c) => {
  const list = await readGithubListContext(c);
  if (!list.ok) return list.response;
  const { userId, owner, repo } = list.ctx;
  try {
    const resolved = await resolveGithubToken(userId);
    return c.json(await fetchIssueFilterOptions(owner, repo, resolved?.token ?? null));
  } catch (error: any) {
    log.warn('failed to load issue filter options', {
      namespace: 'github-issues',
      repo: `${owner}/${repo}`,
      error: error?.message,
    });
    return c.json({ error: error.message }, 502);
  }
});

// ── GET /issue-timeline — comments and events of one issue, oldest first ──────

issueRoutes.get('/issue-timeline', async (c) => {
  const projectId = c.req.query('projectId');
  const issueNumber = positiveIntParam(c, 'issueNumber');
  if (!projectId || !issueNumber) {
    return c.json({ error: 'projectId and issueNumber are required' }, 400);
  }

  const repo = await githubRepoFor(c, projectId);
  if (repo instanceof Response) return repo;

  try {
    const items = await fetchIssueTimeline(repo, issueNumber);
    if (!items) return c.json({ error: 'Issue not found' }, 404);
    return c.json({ items });
  } catch (error: any) {
    log.warn('failed to load issue timeline', {
      namespace: 'github-issues',
      repo: `${repo.owner}/${repo.repo}`,
      issueNumber,
      error: error?.message,
    });
    return c.json({ error: error.message }, 502);
  }
});

// ── GET /issue — one issue, for funny's issue view ──────

issueRoutes.get('/issue', async (c) => {
  const projectId = c.req.query('projectId');
  const issueNumber = positiveIntParam(c, 'issueNumber');
  if (!projectId || !issueNumber) {
    return c.json({ error: 'projectId and issueNumber are required' }, 400);
  }

  const repo = await githubRepoFor(c, projectId);
  if (repo instanceof Response) return repo;

  try {
    const res = await fetchIssue(repo, issueNumber);
    if (res.status === 404) return c.json({ error: 'Issue not found' }, 404);
    if (!res.ok) return c.json({ error: `GitHub API error: ${res.status}` }, 502);
    // SAFETY: the shape of GitHub's REST issue response.
    const raw = (await res.json()) as GitHubIssue;
    // The issues endpoint answers pull requests too; those open in the PR view.
    if (raw.pull_request) return c.json({ error: 'Not an issue' }, 404);
    const issue: EnrichedGitHubIssue = {
      number: raw.number,
      title: raw.title,
      state: raw.state,
      body: raw.body,
      created_at: raw.created_at,
      updated_at: raw.updated_at,
      html_url: raw.html_url,
      user: raw.user ? { login: raw.user.login, avatar_url: raw.user.avatar_url } : null,
      labels: (raw.labels ?? []).map((label) => ({ name: label.name, color: label.color })),
      comments: raw.comments ?? 0,
      linkedBranch: null,
      linkedPR: null,
      suggestedBranchName: suggestBranchName(raw.number, raw.title),
    };
    return c.json({ issue });
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
});
