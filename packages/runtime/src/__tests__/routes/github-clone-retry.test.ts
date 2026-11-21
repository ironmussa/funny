import { describe, test, expect, vi, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { WSEvent } from '@funny/shared';
import { internal } from '@funny/shared/errors';
import { advanceTimersByTimeAsync } from '@funny/test-kit';
import { Hono } from 'hono';
import { err, ok, okAsync } from 'neverthrow';

/**
 * Regression: POST /clone retries `createProject` (3 attempts, 1s then 2s
 * backoff) because the runner→server data channel can be transiently
 * saturated right after a slow clone. Only thrown errors are retried; a
 * neverthrow `err(...)` is a definitive answer. When registration ultimately
 * fails, the freshly cloned directory must be removed. The route answers 202
 * when the clone starts; the outcome is the last `clone:progress` event.
 */

const mocks = (() => ({
  createProject: vi.fn(),
  projectNameExists: vi.fn(async () => false),
  rm: vi.fn(async () => undefined),
  warn: vi.fn<(message: string, meta?: { attempt?: number }) => void>(),
  error: vi.fn(),
  emitToUser: vi.fn<(userId: string, event: WSEvent) => void>(),
  cloneRepository: vi.fn(),
}))();

const actualFunnyCoreGit = { ...(await import('@funny/core/git')) };
mock.module('@funny/core/git', () => ({
  ...actualFunnyCoreGit,
  cloneRepository: mocks.cloneRepository,
}));

mock.module('../../services/service-registry.js', () => ({
  getServices: () => ({
    projects: {
      createProject: mocks.createProject,
      projectNameExists: mocks.projectNameExists,
    },
  }),
}));

mock.module('../../routes/github/helpers.js', () => ({
  githubApiFetch: vi.fn(),
  resolveGithubToken: vi.fn(async () => null),
}));

mock.module('../../utils/path-scope.js', () => ({
  requirePickerPath: vi.fn(async () => null),
}));

mock.module('../../services/ws-broker.js', () => ({
  wsBroker: { emitToUser: mocks.emitToUser },
}));

mock.module('../../lib/logger.js', () => ({
  log: { warn: mocks.warn, error: mocks.error, info: vi.fn(), debug: vi.fn() },
}));

const actualFsPromises = { ...(await import('fs/promises')) };
mock.module('fs/promises', () => ({
  ...actualFsPromises,
  rm: mocks.rm,
}));

import { repoRoutes } from '../../routes/github/repos.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { eventOfType } from '../helpers/builders-routes.js';

const USER = 'user-1';
const CLONE_URL = 'https://github.com/acme/widget.git';

function app() {
  const a = new Hono<HonoEnv>();
  a.use('*', async (c, next) => {
    c.set('userId', USER);
    await next();
  });
  a.route('/gh', repoRoutes);
  return a;
}

function postClone(destinationPath: string) {
  return app().request('/gh/clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cloneUrl: CLONE_URL, destinationPath }),
  });
}

function attemptWarnings() {
  return mocks.warn.mock.calls.filter((call) => call[0] === 'createProject attempt failed');
}

function lastProgress() {
  const calls = mocks.emitToUser.mock.calls;
  return eventOfType(calls.at(-1)?.[1], 'clone:progress')?.data;
}

describe('POST /clone createProject retry', () => {
  let parentDir: string;
  let clonePath: string;

  beforeEach(() => {
    parentDir = mkdtempSync(join(tmpdir(), 'funny-clone-retry-'));
    clonePath = join(parentDir, 'widget');
    mocks.createProject.mockReset();
    mocks.rm.mockClear();
    mocks.warn.mockClear();
    mocks.error.mockClear();
    mocks.emitToUser.mockClear();
    // Successful `git clone` without touching the network or the filesystem.
    mocks.cloneRepository.mockReset();
    mocks.cloneRepository.mockReturnValue(okAsync(undefined));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(parentDir, { recursive: true, force: true });
  });

  test('retries thrown failures with 1s then 2s delays and succeeds on the third attempt', async () => {
    const project = { id: 'p-1', name: 'widget', path: '' };
    mocks.createProject
      .mockRejectedValueOnce(new Error('data:create_project timed out'))
      .mockRejectedValueOnce(new Error('data:create_project timed out'))
      .mockResolvedValueOnce(ok(project));

    const pending = postClone(parentDir);

    await advanceTimersByTimeAsync(0);
    expect(mocks.createProject).toHaveBeenCalledTimes(1);
    expect(mocks.createProject).toHaveBeenCalledWith('widget', clonePath, USER);

    await advanceTimersByTimeAsync(999);
    expect(mocks.createProject).toHaveBeenCalledTimes(1);
    await advanceTimersByTimeAsync(1);
    expect(mocks.createProject).toHaveBeenCalledTimes(2);

    await advanceTimersByTimeAsync(1_999);
    expect(mocks.createProject).toHaveBeenCalledTimes(2);
    await advanceTimersByTimeAsync(1);
    expect(mocks.createProject).toHaveBeenCalledTimes(3);

    const res = await pending;
    expect(res.status).toBe(202);
    await advanceTimersByTimeAsync(0);
    expect(lastProgress()).toMatchObject({ status: 'done', projectId: 'p-1' });
    expect(mocks.rm).not.toHaveBeenCalled();
    expect(attemptWarnings()).toHaveLength(2);
    expect(attemptWarnings().map((c) => c[1]?.attempt)).toEqual([1, 2]);
  });

  test('gives up after 3 thrown failures, removes the clone dir and returns an error', async () => {
    mocks.createProject.mockRejectedValue(new Error('data channel down'));

    const pending = postClone(parentDir);
    await advanceTimersByTimeAsync(10_000);
    const res = await pending;

    expect(res.status).toBe(202);
    expect(lastProgress()).toMatchObject({ status: 'failed', error: 'data channel down' });
    expect(mocks.createProject).toHaveBeenCalledTimes(3);
    expect(mocks.rm).toHaveBeenCalledTimes(1);
    expect(mocks.rm).toHaveBeenCalledWith(clonePath, {
      recursive: true,
      force: true,
    });
    expect(attemptWarnings()).toHaveLength(3);
    expect(attemptWarnings().map((c) => c[1]?.attempt)).toEqual([1, 2, 3]);
    expect(mocks.error).toHaveBeenCalledWith(
      'createProject failed after successful clone',
      expect.objectContaining({ clonePath, attempts: 3 }),
    );
    expect(mocks.error).toHaveBeenCalledWith(
      'Clone failed',
      expect.objectContaining({ clonePath, stage: 'create-project' }),
    );
  });

  test('does not retry a neverthrow err() result, but still cleans up', async () => {
    mocks.createProject.mockResolvedValue(err(internal('Project already registered')));

    const pending = postClone(parentDir);
    await advanceTimersByTimeAsync(10_000);
    const res = await pending;

    expect(res.status).toBe(202);
    expect(lastProgress()?.status).toBe('failed');
    expect(lastProgress()?.error).toContain('Project already registered');
    expect(mocks.createProject).toHaveBeenCalledTimes(1);
    expect(attemptWarnings()).toHaveLength(0);
    expect(mocks.rm).toHaveBeenCalledWith(clonePath, {
      recursive: true,
      force: true,
    });
  });
});
