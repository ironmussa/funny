import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { processError } from '@funny/shared/errors';
import { Hono } from 'hono';
import { errAsync, ok, okAsync } from 'neverthrow';
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
  emitToUser: vi.fn(),
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
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { repoRoutes } from '../../routes/github/repos.js';
import type { HonoEnv } from '../../types/hono-env.js';

const CLONE_URL = 'https://github.com/acme/widget.git';

function postClone(destinationPath: string) {
  const a = new Hono<HonoEnv>();
  a.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  a.route('/gh', repoRoutes);
  return a.request('/gh/clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cloneUrl: CLONE_URL, destinationPath }),
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
  });

  afterEach(() => {
    rmSync(parentDir, { recursive: true, force: true });
  });

  test('clones the clean URL and passes the token separately', async () => {
    mocks.cloneRepository.mockReturnValue(okAsync(undefined));

    const res = await postClone(parentDir);

    expect(res.status).toBe(201);
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

    const phases = mocks.emitToUser.mock.calls.map(
      (call) => (call[1] as { data: { phase: string; percent?: number } }).data,
    );
    expect(phases).toContainEqual(
      expect.objectContaining({ phase: 'Receiving objects:  45% (9/20)', percent: 45 }),
    );
  });

  test('answers git stderr when the clone fails, without creating the project', async () => {
    mocks.cloneRepository.mockReturnValue(
      errAsync(processError('fatal: repository not found', 128, 'fatal: repository not found')),
    );

    const res = await postClone(parentDir);

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      'Clone failed: fatal: repository not found',
    );
    expect(mocks.createProject).not.toHaveBeenCalled();
  });
});
