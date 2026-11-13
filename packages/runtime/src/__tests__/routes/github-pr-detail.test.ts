import { Hono } from 'hono';
import { ok } from 'neverthrow';
import { describe, test, expect, vi, beforeEach } from 'vitest';

/**
 * GET /pr-detail: project / token checks, the single GraphQL request it makes,
 * and its error responses. The mapping of the GraphQL answer (checks, review
 * decision, mergeable state) is covered in github-pr-detail-graphql.test.ts.
 *
 * The route used to make five REST calls, falling back to the default branch's
 * HEAD check runs when the PR head's failed; that fallback showed another
 * commit's checks and is gone.
 */

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  getGithubToken: vi.fn(),
  githubGraphQL: vi.fn(),
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
  githubGraphQL: mocks.githubGraphQL,
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

function checkRun(id: number, status: string, conclusion: string | null) {
  return {
    databaseId: id,
    name: `check-${id}`,
    status,
    conclusion,
    url: `h${id}`,
    startedAt: 's',
    completedAt: 'e',
  };
}

const PR_NODE = {
  number: 7,
  title: 'Add thing',
  body: 'desc',
  state: 'OPEN',
  isDraft: false,
  merged: false,
  mergeable: 'MERGEABLE',
  url: 'https://github.com/acme/repo/pull/7',
  additions: 3,
  deletions: 1,
  changedFiles: 2,
  createdAt: 'c',
  updatedAt: 'u',
  author: { login: 'alice', avatarUrl: 'a.png' },
  headRefName: 'feat',
  headRefOid: 'abc',
  baseRefName: 'main',
  reviews: {
    nodes: [
      { state: 'APPROVED', author: { login: 'bob' } },
      { state: 'CHANGES_REQUESTED', author: { login: 'carol' } },
      { state: 'COMMENTED', author: { login: 'dan' } },
    ],
  },
  commits: {
    totalCount: 1,
    nodes: [
      {
        commit: {
          oid: 'abc',
          message: 'msg',
          committedDate: 'd1',
          author: { name: 'Alice', user: { login: 'alice', avatarUrl: 'a.png' } },
          checkSuites: {
            nodes: [
              {
                app: { name: 'ci' },
                checkRuns: {
                  nodes: [
                    checkRun(1, 'COMPLETED', 'SUCCESS'),
                    checkRun(2, 'COMPLETED', 'NEUTRAL'),
                    checkRun(3, 'COMPLETED', 'SKIPPED'),
                    checkRun(4, 'COMPLETED', 'FAILURE'),
                    checkRun(5, 'IN_PROGRESS', null),
                  ],
                },
              },
            ],
          },
        },
      },
    ],
  },
};

const answer = (pullRequest: unknown) =>
  mocks.githubGraphQL.mockResolvedValue({ repository: { pullRequest } });

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

  test('makes one GraphQL request with the repository, the PR number and the token', async () => {
    answer(PR_NODE);
    await get();
    expect(mocks.githubGraphQL).toHaveBeenCalledTimes(1);
    expect(mocks.githubGraphQL.mock.calls[0].slice(1)).toEqual([
      { owner: 'acme', repo: 'repo', number: 7 },
      'tok',
    ]);
  });

  test('401 when no GitHub token is available', async () => {
    mocks.getGithubToken.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(401);
    expect(mocks.githubGraphQL).not.toHaveBeenCalled();
  });

  test('502 when the PR does not exist', async () => {
    answer(null);
    const res = await get();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'GitHub API error fetching PR: 404' });
  });

  test('502 with the error message when the request fails', async () => {
    mocks.githubGraphQL.mockRejectedValue(new Error('GitHub GraphQL error: 500'));
    const res = await get();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'GitHub GraphQL error: 500' });
  });

  test('answers the PR with its head checks, last commit and review decision', async () => {
    answer(PR_NODE);
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
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
});
