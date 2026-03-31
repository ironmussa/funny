import type { GitStatusInfo } from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import { okAsync, errAsync } from 'neverthrow';
import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api', () => ({
  api: {
    getGitStatuses: vi.fn(),
    getGitStatus: vi.fn(),
  },
}));

import { api } from '@/lib/api';
import { useGitStatusStore, _resetCooldowns, branchKey } from '@/stores/git-status-store';

const mockApi = vi.mocked(api);

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
      loadingProjects: new Set(),
      _loadingBranchKeys: new Set(),
    });
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
});
