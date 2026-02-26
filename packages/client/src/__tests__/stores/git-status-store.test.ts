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
import { useGitStatusStore, _resetCooldowns } from '@/stores/git-status-store';

const mockApi = vi.mocked(api);

function makeStatus(overrides: Partial<GitStatusInfo> & { threadId: string }): GitStatusInfo {
  return {
    state: 'dirty',
    dirtyFileCount: 3,
    unpushedCommitCount: 1,
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
      statusByThread: {},
      loadingProjects: new Set(),
      _loadingThreads: new Set(),
    });
    _resetCooldowns();
    vi.clearAllMocks();
  });

  // ── 1. Initial state ──────────────────────────────────────
  describe('Initial state', () => {
    test('has empty statusByThread and loadingProjects', () => {
      const state = useGitStatusStore.getState();
      expect(state.statusByThread).toEqual({});
      expect(state.loadingProjects.size).toBe(0);
    });
  });

  // ── 2. fetchForProject ────────────────────────────────────
  describe('fetchForProject', () => {
    test('updates statusByThread with statuses from API', async () => {
      const s1 = makeStatus({ threadId: 't1', state: 'dirty', dirtyFileCount: 2, linesAdded: 5 });
      const s2 = makeStatus({
        threadId: 't2',
        state: 'pushed',
        dirtyFileCount: 0,
        unpushedCommitCount: 0,
      });

      mockApi.getGitStatuses.mockReturnValueOnce(okAsync({ statuses: [s1, s2] }) as any);

      await useGitStatusStore.getState().fetchForProject('p1');

      const { statusByThread } = useGitStatusStore.getState();
      expect(statusByThread['t1']).toEqual(s1);
      expect(statusByThread['t2']).toEqual(s2);
    });

    test('handles API errors gracefully', async () => {
      const error: DomainError = { type: 'INTERNAL', message: 'Server error' };
      mockApi.getGitStatuses.mockReturnValueOnce(errAsync(error) as any);

      // Should not throw
      await useGitStatusStore.getState().fetchForProject('p1');

      // State should remain unchanged
      expect(useGitStatusStore.getState().statusByThread).toEqual({});
    });

    test('deduplicates concurrent calls for the same project', async () => {
      const s1 = makeStatus({ threadId: 't1' });

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
    test('updates statusByThread for a single thread', async () => {
      const s1 = makeStatus({ threadId: 't1', state: 'unpushed', unpushedCommitCount: 3 });

      mockApi.getGitStatus.mockReturnValueOnce(okAsync(s1) as any);

      await useGitStatusStore.getState().fetchForThread('t1');

      expect(useGitStatusStore.getState().statusByThread['t1']).toEqual(s1);
    });

    test('handles API errors gracefully', async () => {
      const error: DomainError = { type: 'NOT_FOUND', message: 'Thread not found' };
      mockApi.getGitStatus.mockReturnValueOnce(errAsync(error) as any);

      // Should not throw
      await useGitStatusStore.getState().fetchForThread('t1');

      expect(useGitStatusStore.getState().statusByThread).toEqual({});
    });

    test('deduplicates concurrent calls for the same thread', async () => {
      const s1 = makeStatus({ threadId: 't1' });
      mockApi.getGitStatus.mockReturnValue(okAsync(s1) as any);

      const p1 = useGitStatusStore.getState().fetchForThread('t1');
      const p2 = useGitStatusStore.getState().fetchForThread('t1');

      await Promise.all([p1, p2]);

      // Should only call API once due to deduplication
      expect(mockApi.getGitStatus).toHaveBeenCalledTimes(1);
    });

    test('removes thread from _loadingThreads after completion', async () => {
      mockApi.getGitStatus.mockReturnValueOnce(okAsync(makeStatus({ threadId: 't1' })) as any);

      await useGitStatusStore.getState().fetchForThread('t1');

      expect(useGitStatusStore.getState()._loadingThreads.has('t1')).toBe(false);
    });

    test('removes thread from _loadingThreads even on error', async () => {
      const error: DomainError = { type: 'INTERNAL', message: 'fail' };
      mockApi.getGitStatus.mockReturnValueOnce(errAsync(error) as any);

      await useGitStatusStore.getState().fetchForThread('t1');

      expect(useGitStatusStore.getState()._loadingThreads.has('t1')).toBe(false);
    });
  });

  // ── 4. updateFromWS ──────────────────────────────────────
  describe('updateFromWS', () => {
    test('bulk updates statusByThread', () => {
      const s1 = makeStatus({ threadId: 't1', state: 'dirty', dirtyFileCount: 2 });
      const s2 = makeStatus({ threadId: 't2', state: 'pushed', dirtyFileCount: 0 });

      useGitStatusStore.getState().updateFromWS([s1, s2]);

      const { statusByThread } = useGitStatusStore.getState();
      expect(statusByThread['t1']).toEqual(s1);
      expect(statusByThread['t2']).toEqual(s2);
    });

    test('merges with existing data', () => {
      const existing = makeStatus({ threadId: 't1', state: 'dirty', dirtyFileCount: 5 });
      useGitStatusStore.setState({
        statusByThread: { t1: existing },
      });

      const updated = makeStatus({ threadId: 't2', state: 'clean', dirtyFileCount: 0 });
      useGitStatusStore.getState().updateFromWS([updated]);

      const { statusByThread } = useGitStatusStore.getState();
      // Existing entry should still be present
      expect(statusByThread['t1']).toEqual(existing);
      // New entry should be added
      expect(statusByThread['t2']).toEqual(updated);
    });

    test('overwrites existing thread data with new data', () => {
      const original = makeStatus({ threadId: 't1', state: 'dirty', dirtyFileCount: 5 });
      useGitStatusStore.setState({
        statusByThread: { t1: original },
      });

      const updated = makeStatus({ threadId: 't1', state: 'clean', dirtyFileCount: 0 });
      useGitStatusStore.getState().updateFromWS([updated]);

      expect(useGitStatusStore.getState().statusByThread['t1']).toEqual(updated);
    });
  });

  // ── 5. clearForThread ─────────────────────────────────────
  describe('clearForThread', () => {
    test('removes the thread entry', () => {
      const s1 = makeStatus({ threadId: 't1' });
      const s2 = makeStatus({ threadId: 't2' });
      useGitStatusStore.setState({
        statusByThread: { t1: s1, t2: s2 },
      });

      useGitStatusStore.getState().clearForThread('t1');

      const { statusByThread } = useGitStatusStore.getState();
      expect(statusByThread['t1']).toBeUndefined();
      // Other entries should remain
      expect(statusByThread['t2']).toEqual(s2);
    });

    test('does not crash when clearing a non-existent thread', () => {
      useGitStatusStore.setState({ statusByThread: {} });

      // Should not throw
      useGitStatusStore.getState().clearForThread('nonexistent');

      expect(useGitStatusStore.getState().statusByThread).toEqual({});
    });
  });
});
