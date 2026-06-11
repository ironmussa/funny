import type { GitStatusInfo } from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import { okAsync, errAsync, ResultAsync } from 'neverthrow';
import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api/git', () => ({
  gitApi: {
    getGitStatuses: vi.fn(),
    getGitStatus: vi.fn(),
    projectGitStatus: vi.fn(),
  },
}));

import { gitApi } from '@/lib/api/git';
import {
  useGitStatusStore,
  _resetCooldowns,
  branchKey,
  invalidateCooldownsForKeys,
} from '@/stores/git-status-store';
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

describe('GitStatusStore', () => {
  beforeEach(() => {
    useGitStatusStore.setState({
      statusByBranch: {},
      threadToBranchKey: {},
      statusByProject: {},
      loadingProjects: new Set(),
      _loadingBranchKeys: new Set(),
      _loadingProjectStatus: new Set(),
    });
    useThreadStore.setState({
      threadsById: {},
      threadIdsByProject: {},
    } as any);
    _resetCooldowns();
    vi.clearAllMocks();
  });

  // ── 1. Initial state ──────────────────────────────────────
  describe('Initial state', () => {
    test('has empty statusByBranch and loadingProjects', () => {
      const state = useGitStatusStore.getState();
      expect(state.statusByBranch).toEqual({});
      expect(state.threadToBranchKey).toEqual({});
      expect(state.loadingProjects.size).toBe(0);
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

      await useGitStatusStore.getState().fetchForProject('p1');

      const { statusByBranch, threadToBranchKey } = useGitStatusStore.getState();
      expect(statusByBranch['p1:main']).toEqual(s1);
      expect(statusByBranch['p1:feature']).toEqual(s2);
      expect(threadToBranchKey['t1']).toBe('p1:main');
      expect(threadToBranchKey['t2']).toBe('p1:feature');
    });

    test('threads sharing a branch share one cache entry', async () => {
      const s1 = makeStatus({ threadId: 't1', branchKey: 'p1:main', state: 'dirty' });
      const s2 = makeStatus({ threadId: 't2', branchKey: 'p1:main', state: 'dirty' });

      mockApi.getGitStatuses.mockReturnValueOnce(okAsync({ statuses: [s1, s2] }) as any);

      await useGitStatusStore.getState().fetchForProject('p1');

      const { statusByBranch, threadToBranchKey } = useGitStatusStore.getState();
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
      await useGitStatusStore.getState().fetchForProject('p1');

      // State should remain unchanged
      expect(useGitStatusStore.getState().statusByBranch).toEqual({});
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
      const p1 = useGitStatusStore.getState().fetchForProject('p1');
      const p2 = useGitStatusStore.getState().fetchForProject('p1');

      // Release the gate so the in-flight call completes
      resolve();
      await Promise.all([p1, p2]);

      // Should only call API once due to deduplication (second call returns early)
      expect(mockApi.getGitStatuses).toHaveBeenCalledTimes(1);
    });

    test('removes project from loadingProjects after completion', async () => {
      mockApi.getGitStatuses.mockReturnValueOnce(okAsync({ statuses: [] }) as any);

      await useGitStatusStore.getState().fetchForProject('p1');

      expect(useGitStatusStore.getState().loadingProjects.has('p1')).toBe(false);
    });

    test('removes project from loadingProjects even on error', async () => {
      const error: DomainError = { type: 'INTERNAL', message: 'fail' };
      mockApi.getGitStatuses.mockReturnValueOnce(errAsync(error) as any);

      await useGitStatusStore.getState().fetchForProject('p1');

      expect(useGitStatusStore.getState().loadingProjects.has('p1')).toBe(false);
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

      await useGitStatusStore.getState().fetchForThread('t1');

      const { statusByBranch, threadToBranchKey } = useGitStatusStore.getState();
      expect(statusByBranch['p1:dev']).toEqual(s1);
      expect(threadToBranchKey['t1']).toBe('p1:dev');
    });

    test('handles API errors gracefully', async () => {
      const error: DomainError = { type: 'NOT_FOUND', message: 'Thread not found' };
      mockApi.getGitStatus.mockReturnValueOnce(errAsync(error) as any);

      // Should not throw
      await useGitStatusStore.getState().fetchForThread('t1');

      expect(useGitStatusStore.getState().statusByBranch).toEqual({});
    });

    test('deduplicates concurrent calls for the same thread', async () => {
      const s1 = makeStatus({ threadId: 't1', branchKey: 'p1:main' });
      mockApi.getGitStatus.mockReturnValue(okAsync(s1) as any);

      const p1 = useGitStatusStore.getState().fetchForThread('t1');
      const p2 = useGitStatusStore.getState().fetchForThread('t1');

      await Promise.all([p1, p2]);

      // Should only call API once due to deduplication
      expect(mockApi.getGitStatus).toHaveBeenCalledTimes(1);
    });

    test('shares cooldown for threads on the same branch', async () => {
      const s1 = makeStatus({ threadId: 't1', branchKey: 'p1:main' });
      mockApi.getGitStatus.mockReturnValue(okAsync(s1) as any);

      // First call for t1 populates the branchKey mapping
      await useGitStatusStore.getState().fetchForThread('t1');

      // Manually map t2 to the same branchKey (simulating what fetchForProject would do)
      useGitStatusStore.setState((s) => ({
        threadToBranchKey: { ...s.threadToBranchKey, t2: 'p1:main' },
      }));

      // Second call for t2 should skip due to shared cooldown
      await useGitStatusStore.getState().fetchForThread('t2');

      // Only one API call (for t1)
      expect(mockApi.getGitStatus).toHaveBeenCalledTimes(1);
    });

    test('removes branchKey from _loadingBranchKeys after completion', async () => {
      // Pre-populate the mapping so loading tracking works
      useGitStatusStore.setState({ threadToBranchKey: { t1: 'p1:main' } });
      mockApi.getGitStatus.mockReturnValueOnce(
        okAsync(makeStatus({ threadId: 't1', branchKey: 'p1:main' })) as any,
      );

      await useGitStatusStore.getState().fetchForThread('t1');

      expect(useGitStatusStore.getState()._loadingBranchKeys.has('p1:main')).toBe(false);
    });

    test('removes branchKey from _loadingBranchKeys even on error', async () => {
      useGitStatusStore.setState({ threadToBranchKey: { t1: 'p1:main' } });
      const error: DomainError = { type: 'INTERNAL', message: 'fail' };
      mockApi.getGitStatus.mockReturnValueOnce(errAsync(error) as any);

      await useGitStatusStore.getState().fetchForThread('t1');

      expect(useGitStatusStore.getState()._loadingBranchKeys.has('p1:main')).toBe(false);
    });

    test('skips fetch for scratch threads', async () => {
      useThreadStore.setState({
        threadsById: {
          scratch1: { id: 'scratch1', isScratch: true, projectId: '' } as any,
        },
      } as any);

      await useGitStatusStore.getState().fetchForThread('scratch1');

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

      useGitStatusStore.getState().updateFromWS([s1, s2]);

      const { statusByBranch, threadToBranchKey } = useGitStatusStore.getState();
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
      useGitStatusStore.setState({
        statusByBranch: { 'p1:main': existing },
        threadToBranchKey: { t1: 'p1:main' },
      });

      const updated = makeStatus({
        threadId: 't2',
        branchKey: 'p1:feature',
        state: 'clean',
        dirtyFileCount: 0,
      });
      useGitStatusStore.getState().updateFromWS([updated]);

      const { statusByBranch } = useGitStatusStore.getState();
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
      useGitStatusStore.setState({
        statusByBranch: { 'p1:main': original },
        threadToBranchKey: { t1: 'p1:main' },
      });

      const updated = makeStatus({
        threadId: 't1',
        branchKey: 'p1:main',
        state: 'clean',
        dirtyFileCount: 0,
      });
      useGitStatusStore.getState().updateFromWS([updated]);

      expect(useGitStatusStore.getState().statusByBranch['p1:main']).toEqual(updated);
    });

    test('WS update for one thread is visible via sibling thread lookup', () => {
      // t1 and t2 share the same branchKey
      useGitStatusStore.setState({
        threadToBranchKey: { t1: 'p1:main', t2: 'p1:main' },
      });

      const update = makeStatus({
        threadId: 't1',
        branchKey: 'p1:main',
        state: 'dirty',
        dirtyFileCount: 3,
      });
      useGitStatusStore.getState().updateFromWS([update]);

      const { statusByBranch, threadToBranchKey } = useGitStatusStore.getState();
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
      useGitStatusStore.setState({
        statusByBranch: { 'p1:main': existing },
        threadToBranchKey: { t1: 'p1:main' },
      });

      const before = useGitStatusStore.getState().statusByBranch;
      useGitStatusStore.getState().updateFromWS([{ ...existing }]);
      expect(useGitStatusStore.getState().statusByBranch).toBe(before);
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
      const bulkP = useGitStatusStore.getState().fetchForProject('p1');
      const forcedP = useGitStatusStore.getState().fetchForThread('t1', true);

      // Forced fetch resolves first and writes the fresh behind=0.
      await forcedP;
      expect(useGitStatusStore.getState().statusByBranch['p1:main'].unpulledCommitCount).toBe(0);

      // The stale bulk now lands — its older token must be rejected per-key.
      releaseBulk();
      await bulkP;
      expect(useGitStatusStore.getState().statusByBranch['p1:main'].unpulledCommitCount).toBe(0);
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

      await useGitStatusStore.getState().fetchForThread('t1', true);
      expect(useGitStatusStore.getState().statusByBranch['p1:main'].unpulledCommitCount).toBe(0);

      await useGitStatusStore.getState().fetchForThread('t1', true);
      expect(useGitStatusStore.getState().statusByBranch['p1:main'].unpulledCommitCount).toBe(4);
    });
  });

  // ── 5. clearForBranch ─────────────────────────────────────
  describe('clearForBranch', () => {
    test('removes the branch entry', () => {
      const s1 = makeStatus({ threadId: 't1', branchKey: 'p1:main' });
      const s2 = makeStatus({ threadId: 't2', branchKey: 'p1:feature' });
      useGitStatusStore.setState({
        statusByBranch: { 'p1:main': s1, 'p1:feature': s2 },
        threadToBranchKey: { t1: 'p1:main', t2: 'p1:feature' },
      });

      useGitStatusStore.getState().clearForBranch('p1:main');

      const { statusByBranch } = useGitStatusStore.getState();
      expect(statusByBranch['p1:main']).toBeUndefined();
      // Other entries should remain
      expect(statusByBranch['p1:feature']).toEqual(s2);
    });

    test('does not crash when clearing a non-existent branchKey', () => {
      useGitStatusStore.setState({ statusByBranch: {} });

      // Should not throw
      useGitStatusStore.getState().clearForBranch('nonexistent');

      expect(useGitStatusStore.getState().statusByBranch).toEqual({});
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

      await useGitStatusStore.getState().fetchProjectStatus('p1');

      expect(useGitStatusStore.getState().statusByProject.p1).toMatchObject({ branch: 'main' });
    });
  });

  // ── 8. ensureStatusForThreads ─────────────────────────────
  describe('ensureStatusForThreads', () => {
    test('fetches only threads whose branchKey is missing', async () => {
      useGitStatusStore.setState({
        statusByBranch: {
          'p1:main': makeStatus({ threadId: 't1', branchKey: 'p1:main' }),
        },
      });
      mockApi.getGitStatus.mockReturnValue(
        okAsync(makeStatus({ threadId: 't2', branchKey: 'p1:feat' })) as any,
      );

      useGitStatusStore.getState().ensureStatusForThreads([
        { id: 't1', projectId: 'p1', mode: 'local', branch: 'main' },
        { id: 't2', projectId: 'p1', mode: 'local', branch: 'feat' },
      ]);

      await vi.waitFor(() => {
        expect(mockApi.getGitStatus).toHaveBeenCalledTimes(1);
      });
      expect(mockApi.getGitStatus).toHaveBeenCalledWith('t2', expect.any(AbortSignal));
    });

    test('skips scratch threads', () => {
      const fetchSpy = vi.spyOn(useGitStatusStore.getState(), 'fetchForThread');

      useGitStatusStore
        .getState()
        .ensureStatusForThreads([{ id: 'scratch1', projectId: '', isScratch: true } as any]);

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // ── 9. invalidateCooldownsForKeys ─────────────────────────
  describe('invalidateCooldownsForKeys', () => {
    test('clears project cooldown when a branch key in that project is invalidated', async () => {
      mockApi.getGitStatuses.mockReturnValueOnce(okAsync({ statuses: [] }) as any);
      mockApi.getGitStatuses.mockReturnValueOnce(okAsync({ statuses: [] }) as any);

      await useGitStatusStore.getState().fetchForProject('p1');
      expect(mockApi.getGitStatuses).toHaveBeenCalledTimes(1);

      await useGitStatusStore.getState().fetchForProject('p1');
      expect(mockApi.getGitStatuses).toHaveBeenCalledTimes(1);

      invalidateCooldownsForKeys(['p1:main']);
      await useGitStatusStore.getState().fetchForProject('p1');
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
      const bulkPromise = useGitStatusStore.getState().fetchForProject('p1');
      await useGitStatusStore.getState().fetchForThread('t1', true);

      // Forced result applied — badge cleared.
      expect(useGitStatusStore.getState().statusByBranch['p1:main'].unpulledCommitCount).toBe(0);

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
      expect(useGitStatusStore.getState().statusByBranch['p1:main'].unpulledCommitCount).toBe(0);
      expect(useGitStatusStore.getState().statusByBranch['p1:main'].state).toBe('pushed');
    });

    test('a fresh WS update still overrides an older in-flight bulk fetch', async () => {
      // WS events carry the newest token, so they win over an older in-flight
      // HTTP response that resolves afterwards.
      const bulk = deferredOk<{ statuses: GitStatusInfo[] }>();
      mockApi.getGitStatuses.mockReturnValueOnce(bulk.result as any);

      const bulkPromise = useGitStatusStore.getState().fetchForProject('p1');

      // WS delivers fresh behind=0 while the bulk is still in flight.
      useGitStatusStore
        .getState()
        .updateFromWS([
          makeStatus({
            threadId: 't1',
            branchKey: 'p1:main',
            unpulledCommitCount: 0,
            state: 'pushed',
          }),
        ]);
      expect(useGitStatusStore.getState().statusByBranch['p1:main'].unpulledCommitCount).toBe(0);

      // Stale bulk (older token) lands with behind=5 — dropped by the guard.
      bulk.trigger({
        statuses: [makeStatus({ threadId: 't1', branchKey: 'p1:main', unpulledCommitCount: 5 })],
      });
      await bulkPromise;

      expect(useGitStatusStore.getState().statusByBranch['p1:main'].unpulledCommitCount).toBe(0);
    });
  });
});
