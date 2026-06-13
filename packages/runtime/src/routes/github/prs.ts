import { getRemoteUrl } from '@funny/core/git';
import type {
  GitHubPR,
  GitHubUserRef,
  PRDetail,
  PRFilterOptions,
  PRSortKey,
  CICheck,
  ReviewDecision,
  MergeableState,
} from '@funny/shared';
import { Hono } from 'hono';

import { getServices } from '../../services/service-registry.js';
import type { HonoEnv } from '../../types/hono-env.js';
import {
  GITHUB_API,
  githubApiFetch,
  parseGithubOwnerRepo,
  resolveGithubProjectContext,
  resolveGithubToken,
} from './helpers.js';

export const prRoutes = new Hono<HonoEnv>();

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
  };
}

// ── GET /prs — list GitHub pull requests for a project ──────

prRoutes.get('/prs', async (c) => {
  const userId = c.get('userId') as string;
  const projectId = c.req.query('projectId');
  if (!projectId) {
    return c.json({ error: 'projectId is required' }, 400);
  }

  const project = await getServices().projects.getProject(projectId);
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

  const state = c.req.query('state') || 'open';
  const page = Number(c.req.query('page')) || 1;
  const perPage = Math.min(Number(c.req.query('per_page')) || 30, 100);
  const { sort, direction } = resolveSort(c.req.query('sort'), 'pulls');

  try {
    const apiPath = `/repos/${parsed.owner}/${parsed.repo}/pulls?state=${state}&page=${page}&per_page=${perPage}&sort=${sort}&direction=${direction}`;
    const resolved = await resolveGithubToken(userId);
    const token = resolved?.token ?? null;

    let res: Response;
    if (token) {
      res = await githubApiFetch(apiPath, token);
    } else {
      res = await fetch(`${GITHUB_API}${apiPath}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    }

    if (!res.ok) {
      const _body = await res.text();
      return c.json({ error: `GitHub API error: ${res.status}` }, 502);
    }

    const prs = (await res.json()) as GitHubPR[];
    const linkHeader = res.headers.get('Link') || '';
    const hasMore = linkHeader.includes('rel="next"');

    return c.json({ prs, hasMore, owner: parsed.owner, repo: parsed.repo });
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
  const userId = c.get('userId') as string;
  const projectId = c.req.query('projectId');
  if (!projectId) {
    return c.json({ error: 'projectId is required' }, 400);
  }

  const project = await getServices().projects.getProject(projectId);
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

  const state = c.req.query('state') || 'open';
  const page = Number(c.req.query('page')) || 1;
  const perPage = Math.min(Number(c.req.query('per_page')) || 30, 100);
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

    let res: Response;
    if (token) {
      res = await githubApiFetch(apiPath, token);
    } else {
      res = await fetch(`${GITHUB_API}${apiPath}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    }

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

  const project = await getServices().projects.getProject(projectId);
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
  const prNumber = Number(c.req.query('prNumber'));
  if (!projectId || !prNumber) {
    return c.json({ error: 'projectId and prNumber are required' }, 400);
  }

  const project = await getServices().projects.getProject(projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  const remoteResult = await getRemoteUrl(project.path);
  if (remoteResult.isErr() || !remoteResult.value) {
    return c.json({ error: 'Could not determine remote URL' }, 400);
  }

  const parsed = parseGithubOwnerRepo(remoteResult.value);
  if (!parsed) return c.json({ error: 'Not a GitHub project' }, 400);

  const resolved = await resolveGithubToken(userId);
  if (!resolved) return c.json({ error: 'No GitHub token available' }, 401);

  const { owner, repo } = parsed;
  const { token } = resolved;

  try {
    // Fetch PR metadata, reviews, and check runs in parallel
    const [prRes, reviewsRes, checksRes] = await Promise.all([
      githubApiFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`, token),
      githubApiFetch(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, token),
      githubApiFetch(`/repos/${owner}/${repo}/commits/HEAD/check-runs?per_page=100`, token),
    ]);

    if (!prRes.ok) {
      return c.json({ error: `GitHub API error fetching PR: ${prRes.status}` }, 502);
    }

    const prData = (await prRes.json()) as any;

    // Derive review decision from latest reviews per author
    let reviewDecision: ReviewDecision = null;
    if (reviewsRes.ok) {
      const reviews = (await reviewsRes.json()) as any[];
      // Keep only the latest review per author
      const latestByAuthor = new Map<string, string>();
      for (const r of reviews) {
        const author = r.user?.login ?? '';
        if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED') {
          latestByAuthor.set(author, r.state);
        }
      }
      const states = [...latestByAuthor.values()];
      if (states.some((s) => s === 'CHANGES_REQUESTED')) {
        reviewDecision = 'CHANGES_REQUESTED';
      } else if (states.some((s) => s === 'APPROVED')) {
        reviewDecision = 'APPROVED';
      } else if (reviews.length > 0) {
        reviewDecision = 'REVIEW_REQUIRED';
      }
    }

    // Parse CI check runs
    let checks: CICheck[] = [];
    let checksPassed = 0;
    let checksFailed = 0;
    let checksPending = 0;

    // Re-fetch check runs for the actual head SHA
    const headSha = prData.head?.sha;
    let checksData: any = null;
    if (headSha) {
      const realChecksRes = await githubApiFetch(
        `/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100`,
        token,
      );
      if (realChecksRes.ok) {
        checksData = await realChecksRes.json();
      }
    }
    if (!checksData && checksRes.ok) {
      checksData = await checksRes.json();
    }

    if (checksData) {
      checks = ((checksData as any).check_runs ?? []).map((cr: any) => ({
        id: cr.id,
        name: cr.name,
        status: cr.status,
        conclusion: cr.conclusion,
        html_url: cr.html_url ?? null,
        started_at: cr.started_at ?? null,
        completed_at: cr.completed_at ?? null,
        app_name: cr.app?.name ?? null,
      }));

      for (const ck of checks) {
        if (ck.status !== 'completed') checksPending++;
        else if (
          ck.conclusion === 'success' ||
          ck.conclusion === 'neutral' ||
          ck.conclusion === 'skipped'
        )
          checksPassed++;
        else checksFailed++;
      }
    }

    // Map mergeable state
    let mergeableState: MergeableState = 'unknown';
    if (prData.mergeable === true) mergeableState = 'mergeable';
    else if (prData.mergeable === false) mergeableState = 'conflicting';

    const detail: PRDetail = {
      number: prData.number,
      title: prData.title ?? '',
      body: prData.body ?? '',
      state: prData.state ?? 'open',
      draft: prData.draft ?? false,
      merged: prData.merged ?? false,
      mergeable_state: mergeableState,
      html_url: prData.html_url ?? '',
      additions: prData.additions ?? 0,
      deletions: prData.deletions ?? 0,
      changed_files: prData.changed_files ?? 0,
      commits: prData.commits ?? 0,
      head: { ref: prData.head?.ref ?? '', sha: prData.head?.sha ?? '' },
      base: { ref: prData.base?.ref ?? '' },
      user: prData.user ? { login: prData.user.login, avatar_url: prData.user.avatar_url } : null,
      review_decision: reviewDecision,
      checks,
      checks_passed: checksPassed,
      checks_failed: checksFailed,
      checks_pending: checksPending,
      created_at: prData.created_at ?? '',
      updated_at: prData.updated_at ?? '',
    };

    return c.json(detail);
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
});

// ── POST /pr-merge — merge a pull request ──────

const MERGE_METHODS = new Set(['squash', 'merge', 'rebase']);

prRoutes.post('/pr-merge', async (c) => {
  const userId = c.get('userId') as string;
  const raw = (await c.req.json().catch(() => null)) as {
    projectId?: string;
    prNumber?: number;
    method?: 'squash' | 'merge' | 'rebase';
  } | null;

  if (!raw?.projectId || !raw?.prNumber) {
    return c.json({ error: 'projectId and prNumber are required' }, 400);
  }

  const method = raw.method ?? 'squash';
  if (!MERGE_METHODS.has(method)) {
    return c.json({ error: 'Invalid merge method' }, 400);
  }

  const ctx = await resolveGithubProjectContext(raw.projectId, userId);
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
