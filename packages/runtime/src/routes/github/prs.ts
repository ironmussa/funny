import { getRemoteUrl } from '@funny/core/git';
import type { GitHubPR, GitHubUserRef, PRCommit, PRFilterOptions, PRSortKey } from '@funny/shared';
import { Hono } from 'hono';
import { z } from 'zod';

import type { HonoEnv } from '../../types/hono-env.js';
import { parseJsonBody } from '../../validation/request.js';
import {
  GITHUB_API,
  githubApiFetch,
  parseGithubOwnerRepo,
  requireAccessibleProject,
  resolveGithubProjectContext,
  resolveGithubToken,
} from './helpers.js';
import { readGithubListContext } from './list-context.js';
import { fetchPRDetail } from './pr-detail-graphql.js';
import { fetchPullRequests } from './prs-graphql.js';
import { positiveIntParam } from './query.js';

export const prRoutes = new Hono<HonoEnv>();

const prMergeBodySchema = z
  .object({
    projectId: z.string().optional(),
    prNumber: z.union([z.number(), z.string()]).optional(),
    method: z.unknown().optional(),
  })
  .passthrough();

// ── Sorting + search helpers ────────────────────────────────

/**
 * Translate a unified {@link PRSortKey} into the params each GitHub endpoint
 * expects. `/pulls` takes `sort` + `direction`; `/search/issues` takes `sort` +
 * `order`. "most-commented" maps to `popularity` on the list endpoint and
 * `comments` on search — the closest equivalent each one offers.
 */
export function resolveSort(
  key: string | undefined,
  kind: 'pulls' | 'search',
): { sort: string; direction: string } {
  const commentSort = kind === 'pulls' ? 'popularity' : 'comments';
  switch (key as PRSortKey) {
    case 'oldest':
      return { sort: 'created', direction: 'asc' };
    case 'recently-updated':
      return { sort: 'updated', direction: 'desc' };
    case 'least-recently-updated':
      return { sort: 'updated', direction: 'asc' };
    case 'most-commented':
      return { sort: commentSort, direction: 'desc' };
    case 'newest':
    default:
      return { sort: 'created', direction: 'desc' };
  }
}

/** Comma-separated query param → trimmed, de-duped, non-empty values. */
export function listParam(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const v of raw.split(',')) {
    const t = v.trim();
    if (t) seen.add(t);
  }
  return [...seen];
}

/** Quote a GitHub search qualifier value when it contains spaces. */
export function searchValue(v: string): string {
  return /\s/.test(v) ? `"${v}"` : v;
}

/** Map a `/search/issues` PR item onto the {@link GitHubPR} shape. Search items
 *  carry `merged_at` under `pull_request` and never include head/base refs. */
export function mapSearchItemToPR(item: any): GitHubPR {
  return {
    number: item.number,
    title: item.title ?? '',
    body: item.body ?? null,
    state: item.state ?? 'open',
    html_url: item.html_url ?? '',
    user: item.user ? { login: item.user.login, avatar_url: item.user.avatar_url } : null,
    created_at: item.created_at ?? '',
    updated_at: item.updated_at ?? '',
    // Search results don't expose branch refs; leave empty so the client treats
    // them as an un-pinnable flat list (branch-focus is off in search mode).
    head: { ref: '', label: '' },
    base: { ref: '', label: '' },
    draft: item.draft ?? false,
    labels: Array.isArray(item.labels)
      ? item.labels.map((l: any) => ({ name: l.name, color: l.color }))
      : [],
    assignees: Array.isArray(item.assignees)
      ? item.assignees.map((a: any) => ({ login: a.login, avatar_url: a.avatar_url }))
      : [],
    merged_at: item.pull_request?.merged_at ?? null,
    last_commit: null,
  };
}

export function mapCommitToPRCommit(commit: any): PRCommit {
  return {
    sha: commit.sha ?? '',
    message: commit.commit?.message ?? '',
    author: commit.author
      ? { login: commit.author.login, avatar_url: commit.author.avatar_url }
      : null,
    author_name: commit.commit?.author?.name ?? null,
    date: commit.commit?.committer?.date ?? commit.commit?.author?.date ?? '',
  };
}

export async function addLastCommitToPRs(
  prs: GitHubPR[],
  owner: string,
  repo: string,
  fetchGitHubPath: (path: string) => Promise<Response>,
): Promise<GitHubPR[]> {
  return Promise.all(
    prs.map(async (pr) => {
      const sha = pr.head?.sha;
      if (!sha) return { ...pr, last_commit: null };

      try {
        const res = await fetchGitHubPath(`/repos/${owner}/${repo}/commits/${sha}`);
        if (!res.ok) return { ...pr, last_commit: null };
        return { ...pr, last_commit: mapCommitToPRCommit(await res.json()) };
      } catch {
        return { ...pr, last_commit: null };
      }
    }),
  );
}

// ── GET /prs — list GitHub pull requests for a project ──────

const anonymousFetch = (path: string): Promise<Response> =>
  fetch(`${GITHUB_API}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

/** Without a token GraphQL is unavailable: the anonymous REST list, last commit per PR. */
async function anonymousPRList(
  owner: string,
  repo: string,
  query: { state: string; page: number; perPage: number; sort: string; direction: string },
): Promise<{ prs: GitHubPR[]; hasMore: boolean } | { status: number }> {
  const res = await anonymousFetch(
    `/repos/${owner}/${repo}/pulls?state=${query.state}&page=${query.page}&per_page=${query.perPage}&sort=${query.sort}&direction=${query.direction}`,
  );
  if (!res.ok) return { status: res.status };
  const prs = await addLastCommitToPRs(
    (await res.json()) as GitHubPR[],
    owner,
    repo,
    anonymousFetch,
  );
  return { prs, hasMore: (res.headers.get('Link') || '').includes('rel="next"') };
}

prRoutes.get('/prs', async (c) => {
  const list = await readGithubListContext(c);
  if (!list.ok) return list.response;
  const { userId, owner, repo, state, page, perPage, cursor } = list.ctx;
  const { sort, direction } = resolveSort(c.req.query('sort'), 'pulls');

  try {
    const resolved = await resolveGithubToken(userId);
    // With a token, one GraphQL request brings the page with each PR's last
    // commit (see prs-graphql.ts).
    if (resolved) {
      const result = await fetchPullRequests(owner, repo, {
        state,
        sort,
        direction,
        perPage,
        cursor,
        token: resolved.token,
      });
      return c.json({ ...result, owner, repo });
    }

    const result = await anonymousPRList(owner, repo, { state, page, perPage, sort, direction });
    if ('status' in result) return c.json({ error: `GitHub API error: ${result.status}` }, 502);
    return c.json({ ...result, owner, repo });
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
});

// ── GET /prs-search — filter PRs across the whole repo via the Search API ──────
//
// The plain `/pulls` endpoint can't filter by label/author/assignee/reviewer, so
// any active filter routes here. The Search API filters server-side over EVERY
// PR (not just the loaded page). Trade-offs: search items omit branch refs and
// requested_reviewers, so results render as a flat list (no branch pinning), and
// the endpoint is subject to GitHub's stricter search rate limit.

prRoutes.get('/prs-search', async (c) => {
  const list = await readGithubListContext(c);
  if (!list.ok) return list.response;
  const { userId, state, page, perPage } = list.ctx;
  const parsed = { owner: list.ctx.owner, repo: list.ctx.repo };
  const { sort, direction } = resolveSort(c.req.query('sort'), 'search');

  const labels = listParam(c.req.query('labels'));
  const authors = listParam(c.req.query('authors'));
  const assignees = listParam(c.req.query('assignees'));
  const reviewers = listParam(c.req.query('reviewers'));

  // Build the search query. Same-qualifier repeats are OR'd by GitHub (any of
  // the selected authors/assignees/reviewers); distinct `label:` qualifiers are
  // AND'd (must carry every selected label).
  const terms = [`repo:${parsed.owner}/${parsed.repo}`, 'is:pr'];
  if (state === 'open' || state === 'closed') terms.push(`state:${state}`);
  for (const l of labels) terms.push(`label:${searchValue(l)}`);
  for (const a of authors) terms.push(`author:${searchValue(a)}`);
  for (const a of assignees) terms.push(`assignee:${searchValue(a)}`);
  for (const r of reviewers) terms.push(`review-requested:${searchValue(r)}`);

  const q = encodeURIComponent(terms.join(' '));
  const apiPath = `/search/issues?q=${q}&sort=${sort}&order=${direction}&page=${page}&per_page=${perPage}`;

  try {
    const resolved = await resolveGithubToken(userId);
    const token = resolved?.token ?? null;

    const res = token ? await githubApiFetch(apiPath, token) : await anonymousFetch(apiPath);

    if (!res.ok) {
      return c.json({ error: `GitHub API error: ${res.status}` }, 502);
    }

    const body = (await res.json()) as { total_count: number; items: any[] };
    const items = Array.isArray(body.items) ? body.items : [];
    const prs = items.map(mapSearchItemToPR);
    const hasMore = page * perPage < (body.total_count ?? 0);

    return c.json({ prs, hasMore, owner: parsed.owner, repo: parsed.repo });
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
});

// ── GET /pr-filter-options — labels + assignable users for the filter UI ──────

prRoutes.get('/pr-filter-options', async (c) => {
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

  const { owner, repo } = parsed;

  try {
    const resolved = await resolveGithubToken(userId);
    const token = resolved?.token ?? null;

    const fetchPath = (path: string): Promise<Response> =>
      token
        ? githubApiFetch(path, token)
        : fetch(`${GITHUB_API}${path}`, {
            headers: {
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
            },
          });

    // Labels + assignable users (collaborators/org members). The assignable
    // list feeds the author, assignee, and reviewer pickers alike.
    const [labelsRes, usersRes] = await Promise.all([
      fetchPath(`/repos/${owner}/${repo}/labels?per_page=100`),
      fetchPath(`/repos/${owner}/${repo}/assignees?per_page=100`),
    ]);

    const labels = labelsRes.ok
      ? ((await labelsRes.json()) as any[]).map((l) => ({ name: l.name, color: l.color }))
      : [];
    const users: GitHubUserRef[] = usersRes.ok
      ? ((await usersRes.json()) as any[]).map((u) => ({
          login: u.login,
          avatar_url: u.avatar_url,
        }))
      : [];

    const options: PRFilterOptions = { labels, users };
    return c.json(options);
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
});

// ── GET /pr-detail — rich PR data with CI checks and review decision ──────

prRoutes.get('/pr-detail', async (c) => {
  const userId = c.get('userId') as string;
  const projectId = c.req.query('projectId');
  const prNumber = positiveIntParam(c, 'prNumber');
  if (!projectId || !prNumber) {
    return c.json({ error: 'projectId and prNumber are required' }, 400);
  }

  const ctx = await resolveGithubProjectContext(projectId, userId, c.get('organizationId'));
  if (!ctx.ok) return c.json({ error: ctx.error }, ctx.status as any);

  try {
    // One GraphQL request: PR, reviews, head commit and its check runs.
    const detail = await fetchPRDetail(ctx.owner, ctx.repo, prNumber, ctx.token);
    if (!detail) {
      return c.json({ error: 'GitHub API error fetching PR: 404' }, 502);
    }
    return c.json(detail);
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
});

// ── POST /pr-merge — merge a pull request ──────

const MERGE_METHODS = new Set(['squash', 'merge', 'rebase']);

prRoutes.post('/pr-merge', async (c) => {
  const userId = c.get('userId') as string;
  const parsed = await parseJsonBody(c, prMergeBodySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const raw = parsed.value;

  if (!raw?.projectId || !raw?.prNumber) {
    return c.json({ error: 'projectId and prNumber are required' }, 400);
  }

  const method = raw.method ?? 'squash';
  if (typeof method !== 'string' || !MERGE_METHODS.has(method)) {
    return c.json({ error: 'Invalid merge method' }, 400);
  }

  const ctx = await resolveGithubProjectContext(raw.projectId, userId, c.get('organizationId'));
  if (!ctx.ok) return c.json({ error: ctx.error }, ctx.status as any);
  const { owner, repo, token } = ctx;

  try {
    const res = await githubApiFetch(`/repos/${owner}/${repo}/pulls/${raw.prNumber}/merge`, token, {
      method: 'PUT',
      body: JSON.stringify({ merge_method: method }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      const message = body.message || `GitHub API error: ${res.status}`;
      // 405 = not mergeable, 409 = head changed/merge conflict — surface as 409
      const status = res.status === 405 || res.status === 409 ? 409 : 502;
      return c.json({ error: message }, status);
    }

    const data = (await res.json()) as { sha: string; merged: boolean; message: string };
    return c.json({ merged: data.merged, sha: data.sha, message: data.message });
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
});
