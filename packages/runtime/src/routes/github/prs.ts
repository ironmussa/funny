import { getRemoteUrl } from '@funny/core/git';
import type { GitHubPR, PRDetail, CICheck, ReviewDecision, MergeableState } from '@funny/shared';
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

  try {
    const apiPath = `/repos/${parsed.owner}/${parsed.repo}/pulls?state=${state}&page=${page}&per_page=${perPage}&sort=created&direction=desc`;
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
