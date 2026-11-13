import { getRemoteUrl, listBranches } from '@funny/core/git';
import type { GitHubPR } from '@funny/shared';
import { Hono } from 'hono';

import type { HonoEnv } from '../../types/hono-env.js';
import {
  fetchRepoIssues,
  githubApiFetch,
  parseGithubOwnerRepo,
  requireAccessibleProject,
  resolveGithubToken,
} from './helpers.js';
import { linkIssues } from './issue-links.js';
import { readIssueState, readPaging } from './query.js';

export const issueRoutes = new Hono<HonoEnv>();

// ── GET /issues — list GitHub issues for a project ──────

issueRoutes.get('/issues', async (c) => {
  const userId = c.get('userId') as string;
  const projectId = c.req.query('projectId');
  if (!projectId) {
    return c.json({ error: 'projectId is required' }, 400);
  }

  const project = await requireAccessibleProject(projectId, userId, c.get('organizationId'));
  if (!project) {
    return c.json({ error: 'Project not found' }, 404);
  }

  // Get remote URL from the project's git repo
  const remoteResult = await getRemoteUrl(project.path);
  if (remoteResult.isErr() || !remoteResult.value) {
    return c.json({ error: 'Could not determine remote URL for this project' }, 400);
  }

  const parsed = parseGithubOwnerRepo(remoteResult.value);
  if (!parsed) {
    return c.json({ error: 'This project is not hosted on GitHub' }, 400);
  }

  const stateResult = readIssueState(c);
  if (stateResult.isErr()) return c.json({ error: stateResult.error.message }, 400);
  const state = stateResult.value;
  const { page, perPage } = readPaging(c, 30);

  try {
    const resolved = await resolveGithubToken(userId);
    const token = resolved?.token ?? null;

    const result = await fetchRepoIssues(parsed.owner, parsed.repo, {
      state,
      page,
      perPage,
      token,
    });
    if (!result) {
      return c.json({ error: 'GitHub API error' }, 502);
    }

    return c.json({
      issues: result.issues,
      hasMore: result.hasMore,
      owner: parsed.owner,
      repo: parsed.repo,
    });
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

issueRoutes.get('/issues-enriched', async (c) => {
  const userId = c.get('userId') as string;
  const projectId = c.req.query('projectId');
  if (!projectId) {
    return c.json({ error: 'projectId is required' }, 400);
  }

  const project = await requireAccessibleProject(projectId, userId, c.get('organizationId'));
  if (!project) {
    return c.json({ error: 'Project not found' }, 404);
  }

  const remoteResult = await getRemoteUrl(project.path);
  if (remoteResult.isErr() || !remoteResult.value) {
    return c.json({ error: 'Could not determine remote URL for this project' }, 400);
  }

  const parsed = parseGithubOwnerRepo(remoteResult.value);
  if (!parsed) {
    return c.json({ error: 'This project is not hosted on GitHub' }, 400);
  }

  const stateResult = readIssueState(c);
  if (stateResult.isErr()) return c.json({ error: stateResult.error.message }, 400);
  const state = stateResult.value;
  const { page, perPage } = readPaging(c, 30);

  try {
    const resolved = await resolveGithubToken(userId);
    const token = resolved?.token ?? null;

    // Open PRs, plus the most recently updated closed ones so a merged PR
    // still shows on its issue.
    const fetchPRs = async (prState: 'open' | 'closed'): Promise<GitHubPR[]> => {
      if (!token) return [];
      const res = await githubApiFetch(
        `/repos/${parsed.owner}/${parsed.repo}/pulls?state=${prState}&sort=updated&direction=desc&per_page=100`,
        token,
      );
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? (data as GitHubPR[]) : [];
    };

    const [issuesData, branchesResult, openPRs, closedPRs] = await Promise.all([
      // Issues (via Search API so PRs never crowd out issues)
      fetchRepoIssues(parsed.owner, parsed.repo, { state, page, perPage, token }),
      listBranches(project.path),
      fetchPRs('open'),
      fetchPRs('closed'),
    ]);

    if (!issuesData) {
      return c.json({ error: 'Failed to fetch issues' }, 502);
    }

    const enrichedIssues = linkIssues(issuesData.issues, {
      branches: branchesResult.isOk() ? branchesResult.value : [],
      pullRequests: [...openPRs, ...closedPRs],
      repo: `${parsed.owner}/${parsed.repo}`,
      suggestBranchName: (issue) => suggestBranchName(issue.number, issue.title),
    });

    return c.json({
      issues: enrichedIssues,
      hasMore: issuesData.hasMore,
      owner: parsed.owner,
      repo: parsed.repo,
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
});
