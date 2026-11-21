import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Hono } from 'hono';
import { errAsync, ok, okAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * POST /clone is tracked as a background activity (track-background-activities):
 * started on 202 under the client's clone id, ended `succeeded` with the
 * created project or `failed` with git's error, and never records a token.
 */

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  cloneRepository: vi.fn(),
  sendRemoteData: vi.fn(async (_type: string, _payload: Record<string, any>) => ({ ok: true })),
}));

vi.mock('@funny/core/git', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@funny/core/git')>()),
  cloneRepository: mocks.cloneRepository,
}));
vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    projects: { createProject: mocks.createProject, projectNameExists: async () => false },
  }),
}));
vi.mock('../../routes/github/helpers.js', () => ({
  githubApiFetch: vi.fn(),
  resolveGithubToken: vi.fn(async () => ({ token: 'ghp_secret' })),
}));
vi.mock('../../utils/path-scope.js', () => ({ requirePickerPath: vi.fn(async () => null) }));
vi.mock('../../services/ws-broker.js', () => ({ wsBroker: { emitToUser: vi.fn() } }));
vi.mock('../../services/remote-data-channel.js', () => ({ sendRemoteData: mocks.sendRemoteData }));
vi.mock('../../lib/logger.js', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { repoRoutes } from '../../routes/github/repos.js';
import type { HonoEnv } from '../../types/hono-env.js';

function postClone(destinationPath: string, cloneUrl: string) {
  const a = new Hono<HonoEnv>();
  a.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  a.route('/gh', repoRoutes);
  return a.request('/gh/clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cloneUrl, destinationPath, cloneId: 'clone-1' }),
  });
}

const reports = (type: string) =>
  mocks.sendRemoteData.mock.calls.filter(([t]) => t === type).map(([, p]) => p);

async function settle() {
  await vi.waitFor(() =>
    expect(reports('data:activity_update').some((p) => p.patch.status)).toBe(true),
  );
}

describe('POST /clone activity', () => {
  let parentDir: string;

  beforeEach(() => {
    parentDir = mkdtempSync(join(tmpdir(), 'funny-clone-activity-'));
    mocks.sendRemoteData.mockClear();
    mocks.createProject.mockReset();
    mocks.cloneRepository.mockReset();
  });

  afterEach(() => rmSync(parentDir, { recursive: true, force: true }));

  test('starts an activity on 202 and ends it succeeded with the project id', async () => {
    mocks.cloneRepository.mockReturnValue(okAsync(undefined));
    mocks.createProject.mockResolvedValue(ok({ id: 'p-1', name: 'widget', path: '' }));

    const res = await postClone(parentDir, 'https://github.com/acme/widget.git');
    expect(res.status).toBe(202);
    await settle();

    expect(reports('data:activity_start')[0]).toMatchObject({
      id: 'clone-1',
      kind: 'project.clone',
      title: 'Clone widget',
      input: { cloneUrl: 'https://github.com/acme/widget.git', destinationPath: parentDir },
    });
    expect(reports('data:activity_update').at(-1)).toEqual({
      id: 'clone-1',
      patch: { status: 'succeeded', resultRef: { projectId: 'p-1' } },
    });
  });

  test('ends failed with the error when git refuses an existing directory', async () => {
    mocks.cloneRepository.mockReturnValue(
      errAsync({
        type: 'PROCESS_ERROR',
        message: 'git clone failed',
        stderr: "fatal: destination path 'widget' already exists and is not an empty directory.",
        exitCode: 128,
      }),
    );

    expect((await postClone(parentDir, 'https://github.com/acme/widget.git')).status).toBe(202);
    await settle();

    expect(reports('data:activity_update').at(-1)?.patch).toEqual({
      status: 'failed',
      error: "fatal: destination path 'widget' already exists and is not an empty directory.",
    });
  });

  test('records no token in the activity', async () => {
    mocks.cloneRepository.mockReturnValue(okAsync(undefined));
    mocks.createProject.mockResolvedValue(ok({ id: 'p-1', name: 'widget', path: '' }));

    await postClone(parentDir, 'https://github.com/acme/widget.git');
    await settle();

    expect(JSON.stringify(mocks.sendRemoteData.mock.calls)).not.toContain('ghp_secret');
  });
});
