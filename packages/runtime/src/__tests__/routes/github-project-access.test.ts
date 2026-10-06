import { Hono } from 'hono';
import { err, ok } from 'neverthrow';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Regression: the GitHub routes used to load the project by id with no access
 * check, so any authenticated user could read PRs/issues/files — and trigger
 * git + GitHub calls with their token — for a project they cannot access. They
 * now go through the same owner / collaborator / org rule as the git routes,
 * and a foreign project is indistinguishable from a missing one (404).
 */

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  isProjectInOrg: vi.fn(),
  resolveProjectPath: vi.fn(),
  getRemoteUrl: vi.fn(),
}));

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    projects: {
      getProject: mocks.getProject,
      isProjectInOrg: mocks.isProjectInOrg,
      resolveProjectPath: mocks.resolveProjectPath,
    },
    profile: { getGithubToken: vi.fn(async () => null) },
  }),
}));

vi.mock('@funny/core/git', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@funny/core/git')>()),
  getRemoteUrl: mocks.getRemoteUrl,
}));

import { issueRoutes } from '../../routes/github/issues.js';
import { prFileRoutes } from '../../routes/github/pr-files.js';
import { prThreadRoutes } from '../../routes/github/pr-threads.js';
import { prRoutes } from '../../routes/github/prs.js';
import { testRoutes } from '../../routes/tests.js';
import type { HonoEnv } from '../../types/hono-env.js';

const OWNER = 'owner-1';
const STRANGER = 'stranger-1';

function app(userId: string) {
  const a = new Hono<HonoEnv>();
  a.use('*', async (c, next) => {
    c.set('userId', userId);
    c.set('organizationId', null);
    await next();
  });
  a.route('/gh', issueRoutes);
  a.route('/gh', prRoutes);
  a.route('/gh', prFileRoutes);
  a.route('/gh', prThreadRoutes);
  a.route('/tests', testRoutes);
  return a;
}

const q = 'projectId=p-1&prNumber=1&filePath=README.md&sha=abc';
const GET_ROUTES = [
  `/gh/issues?${q}`,
  `/gh/issues-enriched?${q}`,
  `/gh/prs?${q}`,
  `/gh/prs-search?${q}&q=x`,
  `/gh/pr-filter-options?${q}`,
  `/gh/pr-detail?${q}`,
  `/gh/pr-files?${q}`,
  `/gh/pr-commits?${q}`,
  `/gh/commit-authors?${q}`,
  `/gh/pr-file-content?${q}`,
  `/gh/pr-threads?${q}`,
  `/gh/pr-conversation?${q}`,
  '/tests/p-1/files',
  '/tests/p-1/specs?file=a.test.ts',
];

describe('GitHub + tests routes project access', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProject.mockResolvedValue({ id: 'p-1', userId: OWNER, path: '/repo' });
    mocks.isProjectInOrg.mockResolvedValue(false);
    mocks.resolveProjectPath.mockResolvedValue(err({ type: 'NOT_FOUND', message: 'no member' }));
    mocks.getRemoteUrl.mockResolvedValue(ok('https://github.com/acme/repo.git'));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test.each(GET_ROUTES)(
    '%s → 404 for a user without access, with no git/GitHub call',
    async (url) => {
      const res = await app(STRANGER).request(url);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Project not found' });
      expect(mocks.getRemoteUrl).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  test('a foreign project and a missing project return the same response', async () => {
    const foreign = await app(STRANGER).request(`/gh/prs?${q}`);
    mocks.getProject.mockResolvedValue(undefined);
    const missing = await app(STRANGER).request(`/gh/prs?${q}`);

    expect(foreign.status).toBe(missing.status);
    expect(await foreign.json()).toEqual(await missing.json());
  });

  test('the owner passes the access check and reaches the repository', async () => {
    await app(OWNER).request(`/gh/prs?${q}`);
    expect(mocks.getRemoteUrl).toHaveBeenCalledWith('/repo');
  });

  test('a collaborator is admitted and uses their own checkout path', async () => {
    mocks.resolveProjectPath.mockResolvedValue(ok('/home/collab/repo'));
    await app(STRANGER).request(`/gh/prs?${q}`);
    expect(mocks.getRemoteUrl).toHaveBeenCalledWith('/home/collab/repo');
  });
});
