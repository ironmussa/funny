import { listBranches } from '@funny/core/git';
import { Hono } from 'hono';

import { log } from '../../lib/logger.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { fetchRepoIssues, resolveGithubToken } from './helpers.js';
import { linkIssues, type LinkablePR } from './issue-links.js';
import { fetchIssuesWithLinks } from './issues-graphql.js';
import { type GithubListContext, readGithubListContext } from './list-context.js';

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
async function loadIssuesPage(ctx: GithubListContext, token: string | null) {
  const { owner, repo, state, page, perPage, cursor } = ctx;
  if (token) return fetchIssuesWithLinks(owner, repo, { state, perPage, cursor, token });
  const rest = await fetchRepoIssues(owner, repo, { state, page, perPage, token: null });
  if (!rest) return null;
  return { ...rest, pullRequests: [] as LinkablePR[], nextCursor: null };
}

issueRoutes.get('/issues-enriched', async (c) => {
  const list = await readGithubListContext(c);
  if (!list.ok) return list.response;
  const { userId, projectPath, owner, repo } = list.ctx;

  try {
    const resolved = await resolveGithubToken(userId);
    const [issuesData, branchesResult] = await Promise.all([
      loadIssuesPage(list.ctx, resolved?.token ?? null),
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
