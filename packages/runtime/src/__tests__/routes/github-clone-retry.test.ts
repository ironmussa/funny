import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { internal } from '@funny/shared/errors';
import { Hono } from 'hono';
import { err, ok } from 'neverthrow';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Regression: POST /clone retries `createProject` (3 attempts, 1s then 2s
 * backoff) because the runner→server data channel can be transiently
 * saturated right after a slow clone. Only thrown errors are retried; a
 * neverthrow `err(...)` is a definitive answer. When registration ultimately
 * fails, the freshly cloned directory must be removed.
 */

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  projectNameExists: vi.fn(async () => false),
  rm: vi.fn(async () => undefined),
  warn: vi.fn(),
  error: vi.fn(),
  emitToUser: vi.fn(),
}));

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    projects: {
      createProject: mocks.createProject,
      projectNameExists: mocks.projectNameExists,
    },
  }),
}));

vi.mock('../../routes/github/helpers.js', () => ({
  githubApiFetch: vi.fn(),
  resolveGithubToken: vi.fn(async () => null),
}));

vi.mock('../../utils/path-scope.js', () => ({
  requirePickerPath: vi.fn(async () => null),
}));

vi.mock('../../services/ws-broker.js', () => ({
  wsBroker: { emitToUser: mocks.emitToUser },
}));

vi.mock('../../lib/logger.js', () => ({
  log: { warn: mocks.warn, error: mocks.error, info: vi.fn(), debug: vi.fn() },
}));

vi.mock('fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs/promises')>()),
  rm: mocks.rm,
}));

import { repoRoutes } from '../../routes/github/repos.js';
import type { HonoEnv } from '../../types/hono-env.js';

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

function lastProgressPhase(): string | undefined {
  const calls = mocks.emitToUser.mock.calls;
  return (calls.at(-1)?.[1] as { data: { phase: string } } | undefined)?.data.phase;
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
    vi.spyOn(Bun, 'spawn').mockImplementation(
      () =>
        ({
          stdout: null,
          stderr: null,
          exited: Promise.resolve(0),
          exitCode: 0,
        }) as unknown as ReturnType<typeof Bun.spawn>,
    );
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

    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.createProject).toHaveBeenCalledTimes(1);
    expect(mocks.createProject).toHaveBeenCalledWith('widget', clonePath, USER);

    await vi.advanceTimersByTimeAsync(999);
    expect(mocks.createProject).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.createProject).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(mocks.createProject).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.createProject).toHaveBeenCalledTimes(3);

    const res = await pending;
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(project);
    expect(mocks.rm).not.toHaveBeenCalled();
    expect(attemptWarnings()).toHaveLength(2);
    expect(attemptWarnings().map((c) => (c[1] as { attempt: number }).attempt)).toEqual([1, 2]);
  });

  test('gives up after 3 thrown failures, removes the clone dir and returns an error', async () => {
    mocks.createProject.mockRejectedValue(new Error('data channel down'));

    const pending = postClone(parentDir);
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await pending;

    // processError → PROCESS_ERROR → 400 in result-response.ts
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('Clone failed: data channel down');
    expect(mocks.createProject).toHaveBeenCalledTimes(3);
    expect(mocks.rm).toHaveBeenCalledTimes(1);
    expect(mocks.rm).toHaveBeenCalledWith(clonePath, {
      recursive: true,
      force: true,
    });
    expect(attemptWarnings()).toHaveLength(3);
    expect(attemptWarnings().map((c) => (c[1] as { attempt: number }).attempt)).toEqual([1, 2, 3]);
    expect(mocks.error).toHaveBeenCalledWith(
      'createProject failed after successful clone',
      expect.objectContaining({ clonePath, attempts: 3 }),
    );
    expect(lastProgressPhase()).toBe('Clone failed');
  });

  test('does not retry a neverthrow err() result, but still cleans up', async () => {
    mocks.createProject.mockResolvedValue(err(internal('Project already registered')));

    const pending = postClone(parentDir);
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await pending;

    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain('Project already registered');
    expect(mocks.createProject).toHaveBeenCalledTimes(1);
    expect(attemptWarnings()).toHaveLength(0);
    expect(mocks.rm).toHaveBeenCalledWith(clonePath, {
      recursive: true,
      force: true,
    });
    expect(lastProgressPhase()).toBe('Clone failed');
  });
});
