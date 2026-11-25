/**
 * The factory steps route (openspec factory-integration 2.1): a step starts in
 * the thread's own checkout, only for its owner, never for a scratch thread or
 * a thread without a checkout.
 */
import { beforeEach, describe, expect, mock, test, vi } from 'bun:test';
import { join } from 'node:path';

import { forbidden } from '@funny/shared/errors';
import { Hono } from 'hono';
import { err, ok } from 'neverthrow';

const mocks = (() => ({
  requireThread: vi.fn(),
  requireProject: vi.fn(),
  startFactoryStep: vi.fn(),
  getFactoryStep: vi.fn(),
  cancelFactoryStep: vi.fn(),
}))();

const actualHelpers = await import('../../utils/route-helpers.js');
mock.module('../../utils/route-helpers.js', () => ({
  ...actualHelpers,
  requireThread: mocks.requireThread,
  requireProject: mocks.requireProject,
}));
const actualSteps = await import('../../services/factory-steps.js');
mock.module('../../services/factory-steps.js', () => ({
  ...actualSteps,
  startFactoryStep: mocks.startFactoryStep,
  getFactoryStep: mocks.getFactoryStep,
  cancelFactoryStep: mocks.cancelFactoryStep,
}));

const { factoryStepRoutes } = await import('../../routes/factory-steps.js');
import type { HonoEnv } from '../../types/hono-env.js';

const PROJECT_PATH = '/home/funny/work/repo';
/** A directory with a `.git`: this repository's own checkout. */
const CHECKOUT = join(import.meta.dir, '../../../../..');

function app() {
  const hono = new Hono<HonoEnv>();
  hono.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    c.set('organizationId', null);
    await next();
  });
  hono.route('/api/threads', factoryStepRoutes);
  return hono;
}

const start = (body: unknown = { kind: 'command', command: 'bun run lint' }) =>
  app().request('/api/threads/t-1/factory-steps', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('factory steps route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireThread.mockResolvedValue(ok({ id: 't-1', projectId: 'p-1', mode: 'local' }));
    mocks.requireProject.mockResolvedValue(ok({ id: 'p-1', path: PROJECT_PATH }));
    mocks.startFactoryStep.mockReturnValue({ id: 's-1', state: 'running' });
  });

  test("starts a command in the thread's checkout", async () => {
    const res = await start();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stepId: 's-1', state: 'running' });
    expect(mocks.startFactoryStep).toHaveBeenCalledWith(
      't-1',
      PROJECT_PATH,
      expect.objectContaining({ kind: 'command', command: 'bun run lint', timeoutMs: 600_000 }),
    );
  });

  test('a worktree thread runs in its worktree', async () => {
    mocks.requireThread.mockResolvedValue(
      ok({ id: 't-1', projectId: 'p-1', mode: 'worktree', worktreePath: CHECKOUT }),
    );
    await start();
    expect(mocks.startFactoryStep.mock.calls[0]?.[1]).toBe(CHECKOUT);
  });

  test('a worktree that is gone is refused: 409', async () => {
    mocks.requireThread.mockResolvedValue(
      ok({ id: 't-1', projectId: 'p-1', mode: 'worktree', worktreePath: '/nowhere/t-1' }),
    );
    expect((await start()).status).toBe(409);
    expect(mocks.startFactoryStep).not.toHaveBeenCalled();
  });

  // Found on run #479: a retry had removed the worktree, and `integrate` ran
  // in the project's own checkout, on the member's branch.
  test('a worktree thread with no worktree recorded never runs in the project directory: 409', async () => {
    mocks.requireThread.mockResolvedValue(
      ok({ id: 't-1', projectId: 'p-1', mode: 'worktree', worktreePath: null }),
    );
    expect((await start()).status).toBe(409);
    expect(mocks.startFactoryStep).not.toHaveBeenCalled();
  });

  test("a sandbox thread, which records no worktree, runs in its sandbox's checkout", async () => {
    mocks.requireThread.mockResolvedValue(
      ok({ id: 't-1', projectId: 'p-1', mode: 'worktree', worktreePath: null, runtime: 'sandbox' }),
    );
    expect((await start()).status).toBe(200);
    expect(mocks.startFactoryStep.mock.calls[0]?.[1]).toBe(PROJECT_PATH);
  });

  test('refuses a scratch thread, a thread without a project and an invalid body', async () => {
    mocks.requireThread.mockResolvedValueOnce(
      ok({ id: 't-1', projectId: '', mode: 'local', isScratch: true }),
    );
    expect((await start()).status).toBe(400);
    mocks.requireThread.mockResolvedValueOnce(ok({ id: 't-1', projectId: null, mode: 'local' }));
    expect((await start()).status).toBe(400);
    expect((await start({ kind: 'command', command: '' })).status).toBe(400);
    expect(mocks.startFactoryStep).not.toHaveBeenCalled();
  });

  test('answers the project access error and starts nothing', async () => {
    mocks.requireProject.mockResolvedValue(err(forbidden('Access denied')));
    expect((await start()).status).toBe(403);
    expect(mocks.startFactoryStep).not.toHaveBeenCalled();
  });

  test('polls and stops a step, 404 for one it does not know', async () => {
    mocks.getFactoryStep.mockReturnValueOnce({ id: 's-1', state: 'running' });
    const running = await app().request('/api/threads/t-1/factory-steps/s-1');
    expect(await running.json()).toEqual({ state: 'running' });
    mocks.getFactoryStep.mockReturnValueOnce({
      id: 's-1',
      state: 'done',
      result: { kind: 'command' },
    });
    const done = await app().request('/api/threads/t-1/factory-steps/s-1');
    expect(await done.json()).toEqual({ state: 'done', result: { kind: 'command' } });
    mocks.getFactoryStep.mockReturnValueOnce(undefined);
    expect((await app().request('/api/threads/t-1/factory-steps/s-2')).status).toBe(404);
    mocks.cancelFactoryStep.mockReturnValueOnce(true);
    const stopped = await app().request('/api/threads/t-1/factory-steps/s-1', { method: 'DELETE' });
    expect(await stopped.json()).toEqual({ state: 'cancelled' });
    mocks.cancelFactoryStep.mockReturnValueOnce(false);
    const unknown = await app().request('/api/threads/t-1/factory-steps/s-2', { method: 'DELETE' });
    expect(unknown.status).toBe(404);
  });
});
