import { beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import { forbidden } from '@funny/shared/errors';
import { Hono } from 'hono';
import { err, ok } from 'neverthrow';

const mocks = (() => ({
  requireThread: vi.fn(),
  requireProject: vi.fn(),
  startProofJob: vi.fn(),
}))();

mock.module('../../utils/route-helpers.js', () => ({
  requireThread: mocks.requireThread,
  requireProject: mocks.requireProject,
}));
mock.module('../../services/regression-proof.js', () => ({
  startProofJob: mocks.startProofJob,
  getProofJob: vi.fn(),
  cancelProofJob: vi.fn(),
}));

const { regressionProofRoutes } = await import('../../routes/regression-proof.js');
import type { HonoEnv } from '../../types/hono-env.js';

const PROJECT_PATH = '/home/funny/work/repo';

function makeApp() {
  const app = new Hono<HonoEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    c.set('organizationId', null);
    await next();
  });
  app.route('/api/threads', regressionProofRoutes);
  return app;
}

const start = () =>
  makeApp().request('/api/threads/t-1/regression-proof', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ headSha: 'abc1234', defaultBranch: 'master', rules: [] }),
  });

describe('POST /api/threads/:id/regression-proof', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A thread row as the server returns it: `projectId`, never a `projectPath`.
    mocks.requireThread.mockResolvedValue(ok({ id: 't-1', projectId: 'p-1', mode: 'local' }));
    mocks.requireProject.mockResolvedValue(ok({ id: 'p-1', path: PROJECT_PATH }));
    mocks.startProofJob.mockReturnValue({ id: 'proof-1', state: 'running' });
  });

  test("starts the proof in the thread's project path, resolved from its projectId", async () => {
    const res = await start();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ proofId: 'proof-1', state: 'running' });
    expect(mocks.requireProject).toHaveBeenCalledWith('p-1', 'user-1', null);
    expect(mocks.startProofJob).toHaveBeenCalledWith(
      't-1',
      PROJECT_PATH,
      expect.objectContaining({ headSha: 'abc1234', defaultBranch: 'master' }),
    );
  });

  test('refuses a thread without a project', async () => {
    mocks.requireThread.mockResolvedValue(ok({ id: 't-1', projectId: null, mode: 'local' }));
    const res = await start();
    expect(res.status).toBe(400);
    expect(mocks.startProofJob).not.toHaveBeenCalled();
  });

  test('answers the project access error and starts nothing', async () => {
    mocks.requireProject.mockResolvedValue(err(forbidden('Access denied')));
    const res = await start();
    expect(res.status).toBe(403);
    expect(mocks.startProofJob).not.toHaveBeenCalled();
  });
});
