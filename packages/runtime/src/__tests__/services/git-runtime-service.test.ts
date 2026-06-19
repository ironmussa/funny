import { ResultAsync, okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchRemote: vi.fn(),
  invalidateStatusCache: vi.fn(),
  getThread: vi.fn(),
}));

vi.mock('@funny/core/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@funny/core/git')>();
  return {
    ...actual,
    fetchRemote: mocks.fetchRemote,
    invalidateStatusCache: mocks.invalidateStatusCache,
  };
});

vi.mock('../../services/thread-manager.js', () => ({
  getThread: mocks.getThread,
}));

vi.mock('../../lib/telemetry.js', () => ({
  startSpan: vi.fn(() => ({ end: vi.fn() })),
}));

vi.mock('../../lib/logger.js', () => ({
  log: { warn: vi.fn() },
}));

import { gitRuntimeService, gitStatusCache } from '../../services/git-runtime-service.js';

describe('git-runtime-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitStatusCache.clear();
    gitRuntimeService.clearFetchStateForTests();
    mocks.fetchRemote.mockReturnValue(okAsync(true));
    mocks.getThread.mockResolvedValue({ id: 't1', projectId: 'p1' });
  });

  test('dedupes background fetches by repository path while one is in flight', () => {
    let resolveFetch!: (value: boolean) => void;
    const pendingFetch = new Promise<boolean>((resolve) => {
      resolveFetch = resolve;
    });
    mocks.fetchRemote.mockReturnValue(ResultAsync.fromPromise(pendingFetch, String));

    const first = gitRuntimeService.scheduleBackgroundFetch({
      projectId: 'p1',
      projectPath: '/repo',
    });
    const second = gitRuntimeService.scheduleBackgroundFetch({
      projectId: 'p1',
      projectPath: '/repo',
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(mocks.fetchRemote).toHaveBeenCalledTimes(1);

    resolveFetch(true);
  });

  test('explicit project fetch invalidates project and cwd status caches', async () => {
    gitStatusCache.set('p1', { data: { statuses: [] }, ts: Date.now() });

    const result = await gitRuntimeService.fetchProject('p1', { cwd: '/repo' });

    expect(result.isOk()).toBe(true);
    expect(mocks.fetchRemote).toHaveBeenCalledWith('/repo', undefined);
    expect(gitStatusCache.has('p1')).toBe(false);
    expect(mocks.invalidateStatusCache).toHaveBeenCalledWith('/repo');
  });

  test('explicit thread fetch invalidates the owning project cache and cwd status cache', async () => {
    gitStatusCache.set('p1', { data: { statuses: [] }, ts: Date.now() });

    const result = await gitRuntimeService.fetchThread('t1', { cwd: '/worktree' });

    expect(result.isOk()).toBe(true);
    expect(mocks.fetchRemote).toHaveBeenCalledWith('/worktree', undefined);
    expect(mocks.getThread).toHaveBeenCalledWith('t1');
    expect(gitStatusCache.has('p1')).toBe(false);
    expect(mocks.invalidateStatusCache).toHaveBeenCalledWith('/worktree');
  });
});
