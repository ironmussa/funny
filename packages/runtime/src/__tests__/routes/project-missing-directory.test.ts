import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ok } from 'neverthrow';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireProject: vi.fn(), branches: vi.fn(), fetch: vi.fn() }));
vi.mock('../../utils/route-helpers.js', () => ({ requireProject: mocks.requireProject }));
vi.mock('@funny/core/git', () => ({
  getCurrentBranch: vi.fn(async () => ok('main')),
  getDefaultBranch: vi.fn(async () => ok('main')),
  listBranchesDetailed: mocks.branches,
  git: vi.fn(),
  invalidateStatusCache: vi.fn(),
  findWorktreeForBranch: vi.fn(),
  getGitWriteGeneration: vi.fn(() => 0),
  stash: vi.fn(),
}));
vi.mock('../../middleware/tracing.js', () => ({ requestSpan: () => ({ end: vi.fn() }) }));
vi.mock('../../services/git-runtime-service.js', () => ({
  gitRuntimeService: { scheduleBackgroundFetch: mocks.fetch },
}));
vi.mock('../../services/git-service.js', () => ({ resolveIdentity: vi.fn() }));
vi.mock('../../services/thread-manager.js', () => ({ updateThread: vi.fn() }));
vi.mock('../../services/ws-broker.js', () => ({ wsBroker: { emitToUser: vi.fn() } }));

import { projectGitRoutes } from '../../routes/projects/git-routes.js';

let directory: string;
beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(join(tmpdir(), 'funny-directory-'));
  mocks.branches.mockResolvedValue(ok([{ name: 'main', isLocal: true, isRemote: false }]));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test.each(['deleted', 'file', 'file/child'])(
  'reports unavailable directory (%s) before invoking Git',
  async (suffix) => {
    await writeFile(join(directory, 'file'), 'not a directory');
    mocks.requireProject.mockResolvedValue(ok({ id: 'p1', path: join(directory, suffix) }));
    const response = await projectGitRoutes.request('/p1/branches');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      directoryExists: false,
      branches: [],
      remoteBranches: [],
      defaultBranch: null,
      currentBranch: null,
    });
    expect(mocks.branches).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  },
);

test('preserves branch data when the directory exists', async () => {
  mocks.requireProject.mockResolvedValue(ok({ id: 'p1', path: directory }));
  const response = await projectGitRoutes.request('/p1/branches');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    directoryExists: true,
    branches: ['main'],
    remoteBranches: [],
    defaultBranch: 'main',
    currentBranch: 'main',
  });
  expect(mocks.fetch).toHaveBeenCalledOnce();
});
