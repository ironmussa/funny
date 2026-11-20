import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { WSEvent } from '@funny/shared';
import { processError } from '@funny/shared/errors';
import { Hono } from 'hono';
import { errAsync, ok, okAsync, ResultAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Regression (#181): POST /clone ran `git clone https://x-access-token:<PAT>@…`,
 * so the token was in the process list. The route now hands the clean URL to
 * `cloneRepository` and the token separately, which sends it in git's
 * environment scoped to https://github.com/ (see core git-clone.test.ts).
 */

const TOKEN = 'ghp_secret_token';

const mocks = vi.hoisted(() => ({
  cloneRepository: vi.fn(),
  createProject: vi.fn(),
  emitToUser: vi.fn<(userId: string, event: WSEvent) => void>(),
  logError: vi.fn(),
}));

vi.mock('@funny/core/git', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@funny/core/git')>()),
  cloneRepository: mocks.cloneRepository,
}));

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    projects: {
      createProject: mocks.createProject,
      projectNameExists: vi.fn(async () => false),
    },
  }),
}));

vi.mock('../../routes/github/helpers.js', () => ({
  githubApiFetch: vi.fn(),
  resolveGithubToken: vi.fn(async () => ({ token: TOKEN })),
}));

vi.mock('../../utils/path-scope.js', () => ({
  requirePickerPath: vi.fn(async () => null),
}));

vi.mock('../../services/ws-broker.js', () => ({
  wsBroker: { emitToUser: mocks.emitToUser },
}));

vi.mock('../../lib/logger.js', () => ({
  log: { warn: vi.fn(), error: mocks.logError, info: vi.fn(), debug: vi.fn() },
}));

import { repoRoutes } from '../../routes/github/repos.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { eventOfType } from '../helpers/builders-routes.js';

const CLONE_URL = 'https://github.com/acme/widget.git';

function progressEvents() {
  return mocks.emitToUser.mock.calls
    .map((call) => eventOfType(call[1], 'clone:progress'))
    .filter((event) => event !== undefined);
}

/** The clone's last event (`done` or `failed`), once the background job ends. */
async function outcome() {
  await vi.waitFor(() =>
    expect(progressEvents().some((e) => e.data.status !== 'running')).toBe(true),
  );
  return progressEvents().at(-1)!.data;
}

function postClone(destinationPath: string, extra: Record<string, unknown> = {}) {
  const a = new Hono<HonoEnv>();
  a.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  a.route('/gh', repoRoutes);
  return a.request('/gh/clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cloneUrl: CLONE_URL, destinationPath, ...extra }),
  });
}

describe('POST /clone credentials', () => {
  let parentDir: string;

  beforeEach(() => {
    parentDir = mkdtempSync(join(tmpdir(), 'funny-clone-token-'));
    mocks.cloneRepository.mockReset();
    mocks.createProject.mockReset();
    mocks.createProject.mockResolvedValue(ok({ id: 'p-1', name: 'widget', path: '' }));
    mocks.emitToUser.mockClear();
    mocks.logError.mockClear();
  });

  afterEach(() => {
    rmSync(parentDir, { recursive: true, force: true });
  });

  test('clones the clean URL and passes the token separately', async () => {
    mocks.cloneRepository.mockReturnValue(okAsync(undefined));

    const res = await postClone(parentDir);

    expect(res.status).toBe(202);
    expect(await outcome()).toMatchObject({ status: 'done', projectId: 'p-1' });
    expect(mocks.cloneRepository).toHaveBeenCalledTimes(1);
    const [url, destination, options] = mocks.cloneRepository.mock.calls[0];
    expect(url).toBe(CLONE_URL);
    expect(destination).toBe(join(parentDir, 'widget'));
    expect(options.githubToken).toBe(TOKEN);
  });

  test('relays git progress lines with their percentage', async () => {
    mocks.cloneRepository.mockImplementation((_url, _dest, options) => {
      options.onProgress('Receiving objects:  45% (9/20)');
      return okAsync(undefined);
    });

    await postClone(parentDir);
    await outcome();

    const phases = mocks.emitToUser.mock.calls.map(
      (call) => eventOfType(call[1], 'clone:progress')?.data,
    );
    expect(phases).toContainEqual(
      expect.objectContaining({ phase: 'Receiving objects:  45% (9/20)', percent: 45 }),
    );
  });

  test('reports and logs git stderr when the clone fails, without creating the project', async () => {
    mocks.cloneRepository.mockReturnValue(
      errAsync(processError('fatal: repository not found', 128, 'fatal: repository not found')),
    );

    const res = await postClone(parentDir);

    expect(res.status).toBe(202);
    expect(await outcome()).toMatchObject({
      status: 'failed',
      error: 'fatal: repository not found',
    });
    expect(mocks.createProject).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledWith(
      'Clone failed',
      expect.objectContaining({
        clonePath: join(parentDir, 'widget'),
        error: 'fatal: repository not found',
        exitCode: 128,
      }),
    );
  });
});

/**
 * Regression: a large repository took longer than the 30 s the server waits
 * for a runner response, so the browser got a 504 while git kept cloning and
 * a retry hit "Directory already exists". The route now answers when the clone
 * starts and reports the outcome as `clone:progress` events.
 */
describe('POST /clone runs in the background', () => {
  let parentDir: string;

  beforeEach(() => {
    parentDir = mkdtempSync(join(tmpdir(), 'funny-clone-async-'));
    mocks.cloneRepository.mockReset();
    mocks.createProject.mockReset();
    mocks.createProject.mockResolvedValue(ok({ id: 'p-1', name: 'widget', path: '' }));
    mocks.emitToUser.mockClear();
  });

  afterEach(() => {
    rmSync(parentDir, { recursive: true, force: true });
  });

  /** A clone that runs until `finish` is called, like a large repository. */
  function slowClone() {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mocks.cloneRepository.mockReturnValue(ResultAsync.fromSafePromise(done.then(() => undefined)));
    return { finish };
  }

  test('answers 202 with the client cloneId before git finishes', async () => {
    const clone = slowClone();

    const res = await postClone(parentDir, { cloneId: 'abc-123' });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ cloneId: 'abc-123' });
    expect(mocks.createProject).not.toHaveBeenCalled();

    clone.finish();
    const last = await outcome();
    expect(last).toMatchObject({ cloneId: 'abc-123', status: 'done', projectId: 'p-1' });
    // Unscoped: a thread-scoped event for `clone:<id>` is refused by the server.
    expect(progressEvents().every((e) => e.threadId === '')).toBe(true);
  });

  test('generates a cloneId when the client sends none', async () => {
    mocks.cloneRepository.mockReturnValue(okAsync(undefined));

    const res = await postClone(parentDir);

    const { cloneId } = (await res.json()) as { cloneId: string };
    expect(cloneId).toMatch(/^[\w-]+$/);
    expect((await outcome()).cloneId).toBe(cloneId);
  });

  test('refuses a second clone into the same directory while the first runs', async () => {
    const clone = slowClone();
    await postClone(parentDir);

    const second = await postClone(parentDir);
    expect(second.status).toBe(409);
    expect(mocks.cloneRepository).toHaveBeenCalledTimes(1);

    clone.finish();
    await outcome();
    // Finished: the directory is free again (it does not exist on disk here).
    mocks.cloneRepository.mockReturnValue(okAsync(undefined));
    expect((await postClone(parentDir)).status).toBe(202);
  });

  test('rejects a cloneId that is not a plain token', async () => {
    const res = await postClone(parentDir, { cloneId: '../x' });

    expect(res.status).toBe(400);
    expect(mocks.cloneRepository).not.toHaveBeenCalled();
  });
});
