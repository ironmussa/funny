import { Hono } from 'hono';
import { ok } from 'neverthrow';
import { describe, test, expect, vi, beforeEach } from 'vitest';

/**
 * Characterization tests for GET /pr-detail: review decision derivation,
 * CI check aggregation (head-SHA checks with HEAD fallback), mergeable state
 * mapping, and the error responses.
 */

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  getGithubToken: vi.fn(),
  githubApiFetch: vi.fn(),
  getRemoteUrl: vi.fn(),
}));

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    projects: { getProject: mocks.getProject },
    profile: { getGithubToken: mocks.getGithubToken },
  }),
}));

vi.mock('../../routes/github/helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../routes/github/helpers.js')>()),
  githubApiFetch: mocks.githubApiFetch,
}));

vi.mock('@funny/core/git', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@funny/core/git')>()),
  getRemoteUrl: mocks.getRemoteUrl,
  // The `gh auth token` fallback must never see the host's real gh CLI.
  execute: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 1 })),
}));

import { prRoutes } from '../../routes/github/prs.js';
import type { HonoEnv } from '../../types/hono-env.js';

function app() {
  const a = new Hono<HonoEnv>();
  a.use('*', async (c, next) => {
    c.set('userId', 'u-1');
    c.set('organizationId', null);
    await next();
  });
  a.route('/gh', prRoutes);
  return a;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const BASE = '/repos/acme/repo';

const PR = {
  number: 7,
  title: 'Add thing',
  body: 'desc',
  state: 'open',
  draft: false,
  merged: false,
  mergeable: true,
  html_url: 'https://github.com/acme/repo/pull/7',
  additions: 3,
  deletions: 1,
  changed_files: 2,
  commits: 1,
  head: { ref: 'feat', sha: 'abc' },
  base: { ref: 'main' },
  user: { login: 'alice', avatar_url: 'a.png' },
  created_at: 'c',
  updated_at: 'u',
};

function checkRun(id: number, status: string, conclusion: string | null) {
  return {
    id,
    name: `check-${id}`,
    status,
    conclusion,
    html_url: `h${id}`,
    started_at: 's',
    completed_at: 'e',
    app: { name: 'ci' },
  };
}

type Routes = Record<string, Response | (() => Response)>;

function routeFetch(routes: Routes) {
  mocks.githubApiFetch.mockImplementation(async (path: string) => {
    const r = routes[path];
    if (!r) return json({}, 404);
    return typeof r === 'function' ? r() : r;
  });
}

const get = () => app().request('/gh/pr-detail?projectId=p-1&prNumber=7');

describe('GET /pr-detail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProject.mockResolvedValue({ id: 'p-1', userId: 'u-1', path: '/repo' });
    mocks.getRemoteUrl.mockResolvedValue(ok('https://github.com/acme/repo.git'));
    mocks.getGithubToken.mockResolvedValue('tok');
  });

  test('400 when prNumber is missing', async () => {
    const res = await app().request('/gh/pr-detail?projectId=p-1');
    expect(res.status).toBe(400);
  });

  test('400 when the remote is not GitHub', async () => {
    mocks.getRemoteUrl.mockResolvedValue(ok('https://gitlab.com/acme/repo.git'));
    const res = await get();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Not a GitHub project' });
  });

  test('404 when the project is not accessible', async () => {
    mocks.getProject.mockResolvedValue(undefined);
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Project not found' });
  });

  test('400 when the remote URL cannot be determined', async () => {
    mocks.getRemoteUrl.mockResolvedValue(ok(''));
    const res = await get();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Could not determine remote URL' });
  });

  test('passes the resolved token to every GitHub call', async () => {
    routeFetch({ [`${BASE}/pulls/7`]: json({}, 500) });
    await get();
    for (const call of mocks.githubApiFetch.mock.calls) expect(call[1]).toBe('tok');
  });

  test('401 when no GitHub token is available', async () => {
    mocks.getGithubToken.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(401);
    expect(mocks.githubApiFetch).not.toHaveBeenCalled();
  });

  test('502 when the PR fetch fails', async () => {
    routeFetch({ [`${BASE}/pulls/7`]: json({}, 500) });
    const res = await get();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'GitHub API error fetching PR: 500' });
  });

  test('502 with the error message when a fetch throws', async () => {
    mocks.githubApiFetch.mockRejectedValue(new Error('boom'));
    const res = await get();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'boom' });
  });

  test('aggregates head-SHA checks, last commit, and CHANGES_REQUESTED decision', async () => {
    routeFetch({
      [`${BASE}/pulls/7`]: () => json(PR),
      [`${BASE}/pulls/7/reviews`]: () =>
        json([
          { user: { login: 'bob' }, state: 'APPROVED' },
          { user: { login: 'carol' }, state: 'CHANGES_REQUESTED' },
          { user: { login: 'dan' }, state: 'COMMENTED' },
        ]),
      [`${BASE}/commits/HEAD/check-runs?per_page=100`]: () =>
        json({ check_runs: [checkRun(99, 'completed', 'failure')] }),
      [`${BASE}/commits/abc/check-runs?per_page=100`]: () =>
        json({
          check_runs: [
            checkRun(1, 'completed', 'success'),
            checkRun(2, 'completed', 'neutral'),
            checkRun(3, 'completed', 'skipped'),
            checkRun(4, 'completed', 'failure'),
            checkRun(5, 'in_progress', null),
          ],
        }),
      [`${BASE}/commits/abc`]: () =>
        json({
          sha: 'abc',
          commit: { message: 'msg', author: { name: 'Alice', date: 'd1' } },
          author: { login: 'alice', avatar_url: 'a.png' },
        }),
    });

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      number: 7,
      title: 'Add thing',
      body: 'desc',
      state: 'open',
      draft: false,
      merged: false,
      mergeable_state: 'mergeable',
      html_url: 'https://github.com/acme/repo/pull/7',
      additions: 3,
      deletions: 1,
      changed_files: 2,
      commits: 1,
      head: { ref: 'feat', sha: 'abc' },
      base: { ref: 'main' },
      user: { login: 'alice', avatar_url: 'a.png' },
      review_decision: 'CHANGES_REQUESTED',
      checks: [1, 2, 3, 4, 5].map((id) => ({
        id,
        name: `check-${id}`,
        status: id === 5 ? 'in_progress' : 'completed',
        conclusion: ['success', 'neutral', 'skipped', 'failure', null][id - 1],
        html_url: `h${id}`,
        started_at: 's',
        completed_at: 'e',
        app_name: 'ci',
      })),
      checks_passed: 3,
      checks_failed: 1,
      checks_pending: 1,
      created_at: 'c',
      updated_at: 'u',
      last_commit: {
        sha: 'abc',
        message: 'msg',
        author: { login: 'alice', avatar_url: 'a.png' },
        author_name: 'Alice',
        date: 'd1',
      },
    });
  });

  test('falls back to HEAD checks, APPROVED decision, conflicting merge state', async () => {
    routeFetch({
      [`${BASE}/pulls/7`]: () => json({ ...PR, mergeable: false }),
      [`${BASE}/pulls/7/reviews`]: () => json([{ user: { login: 'bob' }, state: 'APPROVED' }]),
      [`${BASE}/commits/HEAD/check-runs?per_page=100`]: () =>
        json({ check_runs: [checkRun(9, 'completed', 'failure')] }),
      [`${BASE}/commits/abc/check-runs?per_page=100`]: () => json({}, 500),
      [`${BASE}/commits/abc`]: () => json({}, 500),
    });

    const body = await (await get()).json();
    expect(body.review_decision).toBe('APPROVED');
    expect(body.mergeable_state).toBe('conflicting');
    expect(body.checks.map((c: any) => c.id)).toEqual([9]);
    expect(body.checks_failed).toBe(1);
    expect(body.last_commit).toBeNull();
  });

  test('REVIEW_REQUIRED for comment-only reviews; defaults for sparse PR data', async () => {
    routeFetch({
      [`${BASE}/pulls/7`]: () => json({ number: 7, mergeable: null }),
      [`${BASE}/pulls/7/reviews`]: () => json([{ user: null, state: 'COMMENTED' }]),
      [`${BASE}/commits/HEAD/check-runs?per_page=100`]: () => json({}, 500),
    });

    const body = await (await get()).json();
    expect(body).toMatchObject({
      review_decision: 'REVIEW_REQUIRED',
      mergeable_state: 'unknown',
      title: '',
      body: '',
      state: 'open',
      head: { ref: '', sha: '' },
      base: { ref: '' },
      user: null,
      checks: [],
      checks_passed: 0,
      checks_failed: 0,
      checks_pending: 0,
      last_commit: null,
    });
    // No head SHA → no per-SHA fetches.
    expect(mocks.githubApiFetch).toHaveBeenCalledTimes(3);
  });

  test('null review decision when reviews fetch fails or there are none', async () => {
    routeFetch({
      [`${BASE}/pulls/7`]: () => json({ ...PR, head: undefined }),
      [`${BASE}/pulls/7/reviews`]: () => json({}, 500),
      [`${BASE}/commits/HEAD/check-runs?per_page=100`]: () => json({ check_runs: undefined }),
    });
    const body = await (await get()).json();
    expect(body.review_decision).toBeNull();
    expect(body.checks).toEqual([]);

    routeFetch({
      [`${BASE}/pulls/7`]: () => json(PR),
      [`${BASE}/pulls/7/reviews`]: () => json([]),
    });
    expect((await (await get()).json()).review_decision).toBeNull();
  });
});
