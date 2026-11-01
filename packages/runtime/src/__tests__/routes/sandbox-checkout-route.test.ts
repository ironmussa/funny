import { notFound } from '@funny/shared/errors';
import { Hono } from 'hono';
import { ok, err } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireThread: vi.fn(),
  requireProject: vi.fn(),
  resolveGithubToken: vi.fn(),
  checkout: vi.fn(),
}));

vi.mock('../../utils/route-helpers.js', () => ({
  requireThread: mocks.requireThread,
  requireProject: mocks.requireProject,
}));
vi.mock('../../routes/github/helpers.js', () => ({
  resolveGithubToken: mocks.resolveGithubToken,
}));
vi.mock('../../services/sandbox-checkout.js', () => ({
  checkoutProjectIntoSandbox: mocks.checkout,
}));

const { sandboxCheckoutRoutes } = await import('../../routes/sandbox-checkout.js');

const PROJECT_PATH = '/home/funny/work/repo';
const REPO = 'https://github.com/ironmussa/funny.git';

function makeApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('userId' as never, 'user-1' as never);
    c.set('organizationId' as never, null as never);
    await next();
  });
  app.route('/api/threads', sandboxCheckoutRoutes as never);
  return app;
}

const post = (body: unknown) =>
  makeApp().request('/api/threads/t-1/sandbox/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/threads/:id/sandbox/checkout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireThread.mockResolvedValue(ok({ id: 't-1', projectId: 'p-1' }));
    mocks.requireProject.mockResolvedValue(ok({ id: 'p-1', path: PROJECT_PATH }));
    mocks.resolveGithubToken.mockResolvedValue({ token: 'gh-token' });
    mocks.checkout.mockResolvedValue(ok({ path: PROJECT_PATH, cloned: true }));
  });

  test('rejects a body with unknown fields', async () => {
    const res = await post({ path: PROJECT_PATH, repoUrl: REPO, extra: 1 });
    expect(res.status).toBe(400);
    expect(mocks.checkout).not.toHaveBeenCalled();
  });

  test('propagates a missing thread', async () => {
    mocks.requireThread.mockResolvedValue(err(notFound('Thread not found')));
    const res = await post({ path: PROJECT_PATH, repoUrl: REPO });
    expect(res.status).toBe(404);
    expect(mocks.checkout).not.toHaveBeenCalled();
  });

  test('rejects scratch threads, which have no repository', async () => {
    mocks.requireThread.mockResolvedValue(ok({ id: 't-1', projectId: null }));
    const res = await post({ path: PROJECT_PATH, repoUrl: REPO });
    expect(res.status).toBe(400);
    expect(mocks.checkout).not.toHaveBeenCalled();
  });

  test('refuses to check out anywhere but the project path', async () => {
    const res = await post({ path: '/home/funny/.ssh', repoUrl: REPO });
    expect(res.status).toBe(403);
    expect(mocks.checkout).not.toHaveBeenCalled();
  });

  test('clones into the project path with the owner token', async () => {
    const res = await post({ path: PROJECT_PATH, repoUrl: REPO });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: PROJECT_PATH, cloned: true });
    expect(mocks.requireThread).toHaveBeenCalledWith('t-1', 'user-1');
    expect(mocks.checkout).toHaveBeenCalledWith({
      path: PROJECT_PATH,
      repoUrl: REPO,
      token: 'gh-token',
    });
  });

  test('passes a null token when the owner has no GitHub credential', async () => {
    mocks.resolveGithubToken.mockResolvedValue(null);
    await post({ path: PROJECT_PATH, repoUrl: REPO });
    expect(mocks.checkout).toHaveBeenCalledWith(expect.objectContaining({ token: null }));
  });
});
