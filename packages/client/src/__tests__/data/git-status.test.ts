import type { GitStatusInfo } from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import { okAsync, errAsync, ResultAsync } from 'neverthrow';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

import { installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

vi.mock('@/lib/api/git', () => ({
  gitApi: {
    getGitStatuses: vi.fn(),
    getGitStatus: vi.fn(),
    projectGitStatus: vi.fn(),
  },
}));

import {
  applyGitStatusEvent,
  applyPRMetadata,
  ensureStatusForThreads,
  fetchForProject,
  fetchForThread,
  fetchProjectStatus,
  markGitStatusStale,
} from '@/data/git-status/actions';
import { branchKey } from '@/data/git-status/keys';
import { readGitStatusMaps, readProjectGitStatus } from '@/data/git-status/read';
import {
  clearGitStatusScope,
  getGitStatusData,
  resetGitStatusScopes,
  setGitStatusScope,
} from '@/data/git-status/store';
import { seedGitStatus } from '@/data/git-status/testing';
import { withThreadIndex } from '@/data/threads/testing';
import { gitApi } from '@/lib/api/git';
import { useThreadStore } from '@/stores/thread-store';

const mockApi = vi.mocked(gitApi);

function makeStatus(
  overrides: Partial<GitStatusInfo> & { threadId: string; branchKey: string },
): GitStatusInfo {
  return {
    state: 'dirty',
    dirtyFileCount: 3,
    unpushedCommitCount: 1,
    unpulledCommitCount: 0,
    hasRemoteBranch: true,
    isMergedIntoBase: false,
    linesAdded: 10,
    linesDeleted: 2,
    ...overrides,
  };
}

afterEach(() => resetTestDataLayer());

describe('git status data', () => {
  beforeEach(() => {
    installTestDataLayer();
    resetGitStatusScopes();
    useThreadStore.setState(
      withThreadIndex({
        threadsById: {},
        threadIdsByProject: {},
      } as any),
    );
    vi.clearAllMocks();
  });

  // ── 1. Initial state ──────────────────────────────────────
  describe('Initial state', () => {
    test('starts with no statuses', () => {
      const state = readGitStatusMaps();
      expect(state.statusByBranch).toEqual({});
      expect(state.threadToBranchKey).toEqual({});
    });
  });

  // ── 2. fetchForProject ────────────────────────────────────
  describe('fetchForProject', () => {
    test('updates statusByBranch with statuses from API', async () => {
      const s1 = makeStatus({
        threadId: 't1',
        branchKey: 'p1:main',
        state: 'dirty',
        dirtyFileCount: 2,
        linesAdded: 5,
      });
      const s2 = makeStatus({
        threadId: 't2',
        branchKey: 'p1:feature',
        state: 'pushed',
        dirtyFileCount: 0,
        unpushedCommitCount: 0,
      });

      mockApi.getGitStatuses.mockReturnValueOnce(okAsync({ statuses: [s1, s2] }) as any);

      await fetchForProject('p1');

      const { statusByBranch, threadToBranchKey } = readGitStatusMaps();
      expect(statusByBranch['p1:main']).toEqual(s1);
      expect(statusByBranch['p1:feature']).toEqual(s2);
      expect(threadToBranchKey['t1']).toBe('p1:main');
      expect(threadToBranchKey['t2']).toBe('p1:feature');
    });

    test('threads sharing a branch share one cache entry', async () => {
      const s1 = makeStatus({ threadId: 't1', branchKey: 'p1:main', state: 'dirty' });
      const s2 = makeStatus({ threadId: 't2', branchKey: 'p1:main', state: 'dirty' });

      mockApi.getGitStatuses.mockReturnValueOnce(okAsync({ statuses: [s1, s2] }) as any);

      await fetchForProject('p1');

      const { statusByBranch, threadToBranchKey } = readGitStatusMaps();
      // Both threads map to the same branchKey
      expect(threadToBranchKey['t1']).toBe('p1:main');
      expect(threadToBranchKey['t2']).toBe('p1:main');
      // One entry in statusByBranch (last writer wins, both are identical)
      expect(statusByBranch['p1:main']).toEqual(s2);
    });

    test('handles API errors gracefully', async () => {
      const error: DomainError = { type: 'INTERNAL', message: 'Server error' };
      mockApi.getGitStatuses.mockReturnValueOnce(errAsync(error) as any);

      // Should not throw
      await fetchForProject('p1');

      // State should remain unchanged
      expect(readGitStatusMaps().statusByBranch).toEqual({});
    });

    test('deduplicates concurrent calls for the same project', async () => {
      const s1 = makeStatus({ threadId: 't1', branchKey: 'p1:main' });

      // Use a deferred promise so the first call stays in-flight
      let resolve!: () => void;
      const gate = new Promise<void>((r) => {
        resolve = r;
      });

      mockApi.getGitStatuses.mockImplementation(() => {
        // Return a ResultAsync that waits on the gate before resolving
        return {
          isOk: () => true,
          isErr: () => false,
          value: { statuses: [s1] },
          then: (onFulfilled: any, onRejected?: any) =>
            gate.then(() => okAsync({ statuses: [s1] })).then(onFulfilled, onRejected),
        } as any;
      });

      // Fire two concurrent fetches for the same project
      const p1 = fetchForProject('p1');
      const p2 = fetchForProject('p1');

      // Release the gate so the in-flight call completes
      resolve();
      await Promise.all([p1, p2]);

      // Should only call API once due to deduplication (second call returns early)
      expect(mockApi.getGitStatuses).toHaveBeenCalledTimes(1);
    });

    test('a failure is reused for the freshness period like a result', async () => {
      const error: DomainError = { type: 'INTERNAL', message: 'fail' };
      mockApi.getGitStatuses.mockReturnValue(errAsync(error) as any);

      await fetchForProject('p1');
      await fetchForProject('p1');

      expect(mockApi.getGitStatuses).toHaveBeenCalledTimes(1);
    });
  });

  // ── 3. fetchForThread ─────────────────────────────────────
  describe('fetchForThread', () => {
    test('updates statusByBranch for a single thread', async () => {
      const s1 = makeStatus({
        threadId: 't1',
        branchKey: 'p1:dev',
        state: 'unpushed',
        unpushedCommitCount: 3,
      });

      mockApi.getGitStatus.mockReturnValueOnce(okAsync(s1) as any);

      await fetchForThread('t1');

      const { statusByBranch, threadToBranchKey } = readGitStatusMaps();
      expect(statusByBranch['p1:dev']).toEqual(s1);
      expect(threadToBranchKey['t1']).toBe('p1:dev');
    });

    test('handles API errors gracefully', async () => {
      const error: DomainError = { type: 'NOT_FOUND', message: 'Thread not found' };
      mockApi.getGitStatus.mockReturnValueOnce(errAsync(error) as any);

      // Should not throw
      await fetchForThread('t1');

      expect(readGitStatusMaps().statusByBranch).toEqual({});
    });

    test('deduplicates concurrent calls for the same thread', async () => {
      const s1 = makeStatus({ threadId: 't1', branchKey: 'p1:main' });
      mockApi.getGitStatus.mockReturnValue(okAsync(s1) as any);

      const p1 = fetchForThread('t1');
      const p2 = fetchForThread('t1');

      await Promise.all([p1, p2]);

      // Should only call API once due to deduplication
      expect(mockApi.getGitStatus).toHaveBeenCalledTimes(1);
    });

    test('shares cooldown for threads on the same branch', async () => {
      const s1 = makeStatus({ threadId: 't1', branchKey: 'p1:main' });
      mockApi.getGitStatus.mockReturnValue(okAsync(s1) as any);

      // First call for t1 populates the branchKey mapping
      await fetchForThread('t1');

      // Manually map t2 to the same branchKey (simulating what fetchForProject would do)
      seedGitStatus({
        threadToBranchKey: { ...readGitStatusMaps().threadToBranchKey, t2: 'p1:main' },
      });

      // Second call for t2 should skip due to shared cooldown
      await fetchForThread('t2');

      // Only one API call (for t1)
      expect(mockApi.getGitStatus).toHaveBeenCalledTimes(1);
    });

    test('skips fetch for scratch threads', async () => {
      useThreadStore.setState(
        withThreadIndex({
          threadsById: {
            scratch1: { id: 'scratch1', isScratch: true, projectId: '' } as any,
          },
        } as any),
      );

      await fetchForThread('scratch1');

      expect(mockApi.getGitStatus).not.toHaveBeenCalled();
    });
  });

  // ── 4. updateFromWS ──────────────────────────────────────
  describe('updateFromWS', () => {
    test('bulk updates statusByBranch', () => {
      const s1 = makeStatus({
        threadId: 't1',
        branchKey: 'p1:main',
        state: 'dirty',
        dirtyFileCount: 2,
      });
      const s2 = makeStatus({
        threadId: 't2',
        branchKey: 'p1:feature',
        state: 'pushed',
        dirtyFileCount: 0,
      });

      applyGitStatusEvent([s1, s2]);

      const { statusByBranch, threadToBranchKey } = readGitStatusMaps();
      expect(statusByBranch['p1:main']).toEqual(s1);
      expect(statusByBranch['p1:feature']).toEqual(s2);
      expect(threadToBranchKey['t1']).toBe('p1:main');
      expect(threadToBranchKey['t2']).toBe('p1:feature');
    });

    test('merges with existing data', () => {
      const existing = makeStatus({
        threadId: 't1',
        branchKey: 'p1:main',
        state: 'dirty',
        dirtyFileCount: 5,
      });
      seedGitStatus({
        statusByBranch: { 'p1:main': existing },
        threadToBranchKey: { t1: 'p1:main' },
      });

      const updated = makeStatus({
        threadId: 't2',
        branchKey: 'p1:feature',
        state: 'clean',
        dirtyFileCount: 0,
      });
      applyGitStatusEvent([updated]);

      const { statusByBranch } = readGitStatusMaps();
      // Existing entry should still be present
      expect(statusByBranch['p1:main']).toEqual(existing);
      // New entry should be added
      expect(statusByBranch['p1:feature']).toEqual(updated);
    });

    test('overwrites existing branch data with new data', () => {
      const original = makeStatus({
        threadId: 't1',
        branchKey: 'p1:main',
        state: 'dirty',
        dirtyFileCount: 5,
      });
      seedGitStatus({
        statusByBranch: { 'p1:main': original },
        threadToBranchKey: { t1: 'p1:main' },
      });

      const updated = makeStatus({
        threadId: 't1',
        branchKey: 'p1:main',
        state: 'clean',
        dirtyFileCount: 0,
      });
      applyGitStatusEvent([updated]);

      expect(readGitStatusMaps().statusByBranch['p1:main']).toEqual(updated);
    });

    test('WS update for one thread is visible via sibling thread lookup', () => {
      // t1 and t2 share the same branchKey
      seedGitStatus({
        threadToBranchKey: { t1: 'p1:main', t2: 'p1:main' },
      });

      const update = makeStatus({
        threadId: 't1',
        branchKey: 'p1:main',
        state: 'dirty',
        dirtyFileCount: 3,
      });
      applyGitStatusEvent([update]);

      const { statusByBranch, threadToBranchKey } = readGitStatusMaps();
      // Both threads resolve to the same status
      const bk1 = threadToBranchKey['t1'];
      const bk2 = threadToBranchKey['t2'];
      expect(bk1).toBe(bk2);
      expect(statusByBranch[bk1!]).toEqual(update);
      expect(statusByBranch[bk2!]).toEqual(update);
    });

    test('is a no-op when incoming statuses are identical', () => {
      const existing = makeStatus({
        threadId: 't1',
        branchKey: 'p1:main',
        state: 'dirty',
        dirtyFileCount: 2,
      });
      seedGitStatus({
        statusByBranch: { 'p1:main': existing },
        threadToBranchKey: { t1: 'p1:main' },
      });

      const before = getGitStatusData().statuses.getSynced('p1:main');
      applyGitStatusEvent([{ ...existing }]);
      expect(getGitStatusData().statuses.getSynced('p1:main')).toBe(before);
    });
  });

  describe('applyPRMetadata', () => {
    test('adds PR metadata to an existing thread status without changing git counts', () => {
      const existing = makeStatus({
        threadId: 't1',
        branchKey: 'p1:feature/pr',
        state: 'dirty',
        dirtyFileCount: 2,
        linesAdded: 12,
        linesDeleted: 4,
      });
      seedGitStatus({
        statusByBranch: { 'p1:feature/pr': existing },
        threadToBranchKey: { t1: 'p1:feature/pr' },
      });

      applyPRMetadata('t1', {
        prNumber: 51,
        prUrl: 'https://github.com/acme/repo/pull/51',
        prState: 'OPEN',
      });

      expect(readGitStatusMaps().statusByBranch['p1:feature/pr']).toEqual({
        ...existing,
        prNumber: 51,
        prUrl: 'https://github.com/acme/repo/pull/51',
        prState: 'OPEN',
      });
    });

    test('is a no-op when the thread has no status entry yet', () => {
      applyPRMetadata('missing-thread', {
        prNumber: 51,
        prUrl: 'https://github.com/acme/repo/pull/51',
        prState: 'OPEN',
      });

      expect(readGitStatusMaps().statusByBranch).toEqual({});
    });
  });

  // ── 4b. Staleness guard (last-writer-wins race) ──────────
  describe('staleness guard', () => {
    test('a slow stale bulk fetch does not overwrite a fresher forced fetch', async () => {
      // Reproduces the "pull badge stuck" bug: a bulk fetchForProject dispatched
      // BEFORE a pull reports `unpulledCommitCount: 5`, but resolves AFTER a
      // forced fetchForThread (dispatched post-pull) that reports 0. Without the
      // per-key write token, the late bulk response clobbers the fresh 0 and the
      // pull badge re-appears and sticks.
      const staleBulk = makeStatus({
        threadId: 't1',
        branchKey: 'p1:main',
        state: 'dirty',
        unpulledCommitCount: 5,
      });
      const freshForced = makeStatus({
        threadId: 't1',
        branchKey: 'p1:main',
        state: 'clean',
        unpulledCommitCount: 0,
      });

      let releaseBulk!: () => void;
      const bulkGate = new Promise<void>((r) => {
        releaseBulk = r;
      });
      mockApi.getGitStatuses.mockImplementation(
        () =>
          ({
            then: (onFulfilled: any, onRejected?: any) =>
              bulkGate.then(() => okAsync({ statuses: [staleBulk] })).then(onFulfilled, onRejected),
          }) as any,
      );
      mockApi.getGitStatus.mockReturnValueOnce(okAsync(freshForced) as any);

      // Dispatch bulk first (token N), then the forced single (token N+1).
      const bulkP = fetchForProject('p1');
      const forcedP = fetchForThread('t1', true);

      // Forced fetch resolves first and writes the fresh behind=0.
      await forcedP;
      expect(readGitStatusMaps().statusByBranch['p1:main'].unpulledCommitCount).toBe(0);

      // The stale bulk now lands — its older token must be rejected per-key.
      releaseBulk();
      await bulkP;
      expect(readGitStatusMaps().statusByBranch['p1:main'].unpulledCommitCount).toBe(0);
    });

    test('a newer fetch still overwrites an older applied value', async () => {
      // Guard must not freeze the slice: a later-dispatched fetch wins.
      mockApi.getGitStatus
        .mockReturnValueOnce(
          okAsync(
            makeStatus({ threadId: 't1', branchKey: 'p1:main', unpulledCommitCount: 0 }),
          ) as any,
        )
        .mockReturnValueOnce(
          okAsync(
            makeStatus({ threadId: 't1', branchKey: 'p1:main', unpulledCommitCount: 4 }),
          ) as any,
        );

      await fetchForThread('t1', true);
      expect(readGitStatusMaps().statusByBranch['p1:main'].unpulledCommitCount).toBe(0);

      await fetchForThread('t1', true);
      expect(readGitStatusMaps().statusByBranch['p1:main'].unpulledCommitCount).toBe(4);
    });
  });

  // ── 6. branchKey ────────────────────────────────────────────
  describe('branchKey', () => {
    test('worktree thread (mode + worktreePath) gets unique key', () => {
      const key = branchKey({
        id: 't1',
        projectId: 'p1',
        mode: 'worktree',
        branch: 'feature-x',
        worktreePath: '/tmp/wt/feature-x-abc',
      });
      expect(key).toBe('wt:p1:feature-x:t1');
    });

    test('worktree thread (mode only, no worktreePath) gets unique key', () => {
      const key = branchKey({
        id: 't1',
        projectId: 'p1',
        mode: 'worktree',
        branch: 'feature-x',
      });
      expect(key).toBe('wt:p1:feature-x:t1');
    });

    test('local thread with branch groups by project + branch', () => {
      const key = branchKey({
        id: 't2',
        projectId: 'p1',
        mode: 'local',
        branch: 'feature-x',
      });
      expect(key).toBe('p1:feature-x');
    });

    test('worktree and local thread on same branch get different keys', () => {
      const wtKey = branchKey({
        id: 't1',
        projectId: 'p1',
        mode: 'worktree',
        branch: 'feature-x',
        worktreePath: '/tmp/wt/feature-x-abc',
      });
      const localKey = branchKey({
        id: 't2',
        projectId: 'p1',
        mode: 'local',
        branch: 'feature-x',
      });
      expect(wtKey).not.toBe(localKey);
    });

    test('two worktree threads on same branch get different keys', () => {
      const wt1 = branchKey({
        id: 't1',
        projectId: 'p1',
        mode: 'worktree',
        branch: 'feature-x',
        worktreePath: '/tmp/wt/feature-x-abc',
      });
      const wt2 = branchKey({
        id: 't2',
        projectId: 'p1',
        mode: 'worktree',
        branch: 'feature-x',
        worktreePath: '/tmp/wt/feature-x-def',
      });
      expect(wt1).not.toBe(wt2);
    });

    test('local thread without branch groups by project only', () => {
      const key = branchKey({
        id: 't3',
        projectId: 'p1',
      });
      expect(key).toBe('p1');
    });
  });

  // ── 7. fetchProjectStatus ─────────────────────────────────
  describe('fetchProjectStatus', () => {
    test('stores project-level git status', async () => {
      mockApi.projectGitStatus.mockReturnValueOnce(
        okAsync({
          branch: 'main',
          ahead: 0,
          behind: 0,
          staged: [],
          unstaged: [],
          untracked: [],
        }) as any,
      );

      await fetchProjectStatus('p1');

      expect(readProjectGitStatus('p1')).toMatchObject({ branch: 'main' });
    });
  });

  // ── 8. ensureStatusForThreads ─────────────────────────────
  describe('ensureStatusForThreads', () => {
    test('issues one bulk per-project fetch when a branchKey is missing', async () => {
      // Worktree threads each get a unique branchKey, so per-thread fan-out
      // would flood the data channel. ensureStatusForThreads collapses to a
      // single bulk `/git/status?projectId=` request per project instead.
      seedGitStatus({
        statusByBranch: {
          'p1:main': makeStatus({ threadId: 't1', branchKey: 'p1:main' }),
        },
      });
      mockApi.getGitStatuses.mockReturnValue(
        okAsync({ statuses: [makeStatus({ threadId: 't2', branchKey: 'p1:feat' })] }) as any,
      );

      ensureStatusForThreads([
        { id: 't1', projectId: 'p1', mode: 'local', branch: 'main' },
        { id: 't2', projectId: 'p1', mode: 'local', branch: 'feat' },
      ]);

      await vi.waitFor(() => {
        expect(mockApi.getGitStatuses).toHaveBeenCalledTimes(1);
      });
      expect(mockApi.getGitStatuses).toHaveBeenCalledWith('p1', expect.any(AbortSignal));
      // The per-thread endpoint must NOT be used by the sidebar batch path.
      expect(mockApi.getGitStatus).not.toHaveBeenCalled();
    });

    test('fetches each distinct project at most once', async () => {
      mockApi.getGitStatuses.mockReturnValue(okAsync({ statuses: [] }) as any);

      ensureStatusForThreads([
        { id: 'a1', projectId: 'p1', mode: 'worktree', branch: 'feat-a', worktreePath: '/wt/a' },
        { id: 'a2', projectId: 'p1', mode: 'worktree', branch: 'feat-b', worktreePath: '/wt/b' },
        { id: 'b1', projectId: 'p2', mode: 'worktree', branch: 'feat-c', worktreePath: '/wt/c' },
      ]);

      await vi.waitFor(() => {
        expect(mockApi.getGitStatuses).toHaveBeenCalledTimes(2);
      });
      expect(mockApi.getGitStatuses).toHaveBeenCalledWith('p1', expect.any(AbortSignal));
      expect(mockApi.getGitStatuses).toHaveBeenCalledWith('p2', expect.any(AbortSignal));
    });

    test('skips scratch threads', () => {
      ensureStatusForThreads([{ id: 'scratch1', projectId: '', isScratch: true } as any]);

      expect(mockApi.getGitStatuses).not.toHaveBeenCalled();
    });
  });

  // ── 8b. Thread scope ──────────────────────────────────────
  describe('thread scope', () => {
    beforeEach(() => {
      mockApi.getGitStatuses.mockReturnValue(okAsync({ statuses: [] }) as any);
    });

    test('requests only the union of registered visible threads', async () => {
      setGitStatusScope('sidebar', { p1: ['t2', 't1'] });
      setGitStatusScope('activity', { p1: ['t3'], p2: ['x1'] });

      await fetchForProject('p1');

      expect(mockApi.getGitStatuses).toHaveBeenCalledWith('p1', expect.any(AbortSignal), [
        't1',
        't2',
        't3',
      ]);
    });

    test("an 'all' registration requests the whole project", async () => {
      setGitStatusScope('sidebar', { p1: ['t1'] });
      setGitStatusScope('kanban', { p1: 'all' });

      await fetchForProject('p1');

      expect(mockApi.getGitStatuses).toHaveBeenCalledWith('p1', expect.any(AbortSignal));
    });

    test('unregistered projects and cleared scopes fall back to the whole project', async () => {
      setGitStatusScope('sidebar', { p1: ['t1'] });
      clearGitStatusScope('sidebar');

      await fetchForProject('p1');

      expect(mockApi.getGitStatuses).toHaveBeenCalledWith('p1', expect.any(AbortSignal));
    });

    test('a widened scope bypasses the cooldown; a narrowed one does not', async () => {
      setGitStatusScope('sidebar', { p1: ['t1', 't2'] });
      await fetchForProject('p1');

      // Narrowed: already covered by the previous fetch.
      setGitStatusScope('sidebar', { p1: ['t1'] });
      await fetchForProject('p1');
      expect(mockApi.getGitStatuses).toHaveBeenCalledTimes(1);

      // Widened: t3 was never fetched, so its badge would stay empty.
      setGitStatusScope('sidebar', { p1: ['t1', 't3'] });
      await fetchForProject('p1');
      expect(mockApi.getGitStatuses).toHaveBeenCalledTimes(2);
      expect(mockApi.getGitStatuses).toHaveBeenLastCalledWith('p1', expect.any(AbortSignal), [
        't1',
        't3',
      ]);

      // Whole project after a scoped fetch is a widening too.
      clearGitStatusScope('sidebar');
      await fetchForProject('p1');
      expect(mockApi.getGitStatuses).toHaveBeenCalledTimes(3);
    });
  });

  // ── 9. invalidateCooldownsForKeys ─────────────────────────
  describe('invalidateCooldownsForKeys', () => {
    test('clears project cooldown when a branch key in that project is invalidated', async () => {
      mockApi.getGitStatuses.mockReturnValueOnce(okAsync({ statuses: [] }) as any);
      mockApi.getGitStatuses.mockReturnValueOnce(okAsync({ statuses: [] }) as any);

      await fetchForProject('p1');
      expect(mockApi.getGitStatuses).toHaveBeenCalledTimes(1);

      await fetchForProject('p1');
      expect(mockApi.getGitStatuses).toHaveBeenCalledTimes(1);

      markGitStatusStale(['p1:main']);
      await fetchForProject('p1');
      expect(mockApi.getGitStatuses).toHaveBeenCalledTimes(2);
    });
  });

  // ── 10. Staleness guard (last-writer-wins race) ───────────
  describe('staleness guard', () => {
    /** A controllable ResultAsync that resolves only when `trigger` is called. */
    function deferredOk<T>(): { trigger: (v: T) => void; result: ResultAsync<T, never> } {
      let resolveFn!: (v: T) => void;
      const p = new Promise<T>((res) => {
        resolveFn = res;
      });
      return { trigger: (v) => resolveFn(v), result: ResultAsync.fromSafePromise(p) };
    }

    test('a slow bulk fetch that lands after a forced fetch cannot overwrite the fresh status', async () => {
      // Regression for the "pull badge appeared then stuck" race: a bulk
      // fetchForProject dispatched BEFORE a pull (carrying stale behind=2)
      // resolves AFTER the forced fetchForThread dispatched after the pull
      // (carrying fresh behind=0). They write the same statusByBranch['p1:main']
      // under different abort keys, so without the seq guard the stale bulk wins.

      // Bulk dispatched first, resolves last.
      const bulk = deferredOk<{ statuses: GitStatusInfo[] }>();
      mockApi.getGitStatuses.mockReturnValueOnce(bulk.result as any);

      // Forced single fetch dispatched second, resolves immediately, behind=0.
      const fresh = makeStatus({
        threadId: 't1',
        branchKey: 'p1:main',
        state: 'pushed',
        dirtyFileCount: 0,
        unpushedCommitCount: 0,
        unpulledCommitCount: 0,
      });
      mockApi.getGitStatus.mockReturnValueOnce(okAsync(fresh) as any);

      // Dispatch order: bulk (seq 1) then forced (seq 2).
      const bulkPromise = fetchForProject('p1');
      await fetchForThread('t1', true);

      // Forced result applied — badge cleared.
      expect(readGitStatusMaps().statusByBranch['p1:main'].unpulledCommitCount).toBe(0);

      // Now the stale bulk lands with behind=2.
      const stale = makeStatus({
        threadId: 't1',
        branchKey: 'p1:main',
        state: 'dirty',
        unpulledCommitCount: 2,
      });
      bulk.trigger({ statuses: [stale] });
      await bulkPromise;

      // Guard drops the stale write — still behind=0 (badge does NOT reappear).
      expect(readGitStatusMaps().statusByBranch['p1:main'].unpulledCommitCount).toBe(0);
      expect(readGitStatusMaps().statusByBranch['p1:main'].state).toBe('pushed');
    });

    test('a fresh WS update still overrides an older in-flight bulk fetch', async () => {
      // WS events carry the newest token, so they win over an older in-flight
      // HTTP response that resolves afterwards.
      const bulk = deferredOk<{ statuses: GitStatusInfo[] }>();
      mockApi.getGitStatuses.mockReturnValueOnce(bulk.result as any);

      const bulkPromise = fetchForProject('p1');

      // WS delivers fresh behind=0 while the bulk is still in flight.
      applyGitStatusEvent([
        makeStatus({
          threadId: 't1',
          branchKey: 'p1:main',
          unpulledCommitCount: 0,
          state: 'pushed',
        }),
      ]);
      expect(readGitStatusMaps().statusByBranch['p1:main'].unpulledCommitCount).toBe(0);

      // Stale bulk (older token) lands with behind=5 — dropped by the guard.
      bulk.trigger({
        statuses: [makeStatus({ threadId: 't1', branchKey: 'p1:main', unpulledCommitCount: 5 })],
      });
      await bulkPromise;

      expect(readGitStatusMaps().statusByBranch['p1:main'].unpulledCommitCount).toBe(0);
    });
  });
  describe('forced requests', () => {
    test('a forced fetch aborts the request in flight and asks again', async () => {
      let firstSignal: AbortSignal | undefined;
      mockApi.getGitStatuses
        .mockImplementationOnce(((_pid: string, signal: AbortSignal) => {
          firstSignal = signal;
          return ResultAsync.fromSafePromise(new Promise(() => {}));
        }) as any)
        .mockReturnValueOnce(okAsync({ statuses: [] }) as any);

      void fetchForProject('p1');
      await vi.waitFor(() => expect(firstSignal).toBeDefined());
      await fetchForProject('p1', true);

      expect(firstSignal?.aborted).toBe(true);
      expect(mockApi.getGitStatuses).toHaveBeenCalledTimes(2);
    });
  });
});
