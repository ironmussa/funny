import { describe, expect, test } from 'bun:test';

import type { GitStatusInfo } from '@funny/shared';

import {
  createNativeGitStatusStore,
  nativeGitBranchKey,
  nativeGitStatusForThread,
} from '../git-status-state';

function status(threadId: string, branchKey: string, added: number): GitStatusInfo {
  return {
    threadId,
    branchKey,
    state: 'dirty',
    dirtyFileCount: 1,
    unpushedCommitCount: 0,
    unpulledCommitCount: 0,
    hasRemoteBranch: false,
    isMergedIntoBase: false,
    linesAdded: added,
    linesDeleted: 2,
  };
}

describe('native git status state', () => {
  test('shares the freshest status between local threads on the same branch', () => {
    const store = createNativeGitStatusStore();
    const firstThread = { id: 't1', projectId: 'p1', mode: 'local', branch: 'master' } as const;
    const secondThread = { id: 't2', projectId: 'p1', mode: 'local', branch: 'master' } as const;
    store.getState().replace([status('t1', 'p1:master', 10)]);
    expect(nativeGitStatusForThread(store.getState(), secondThread)?.linesAdded).toBe(10);
    store.getState().replace([status('t2', 'p1:master', 20)]);
    expect(nativeGitStatusForThread(store.getState(), firstThread)?.linesAdded).toBe(20);
    expect(Object.keys(store.getState().byThreadId)).toEqual(['t1', 't2']);
  });

  test('keeps worktree statuses isolated even when their branch names match', () => {
    const store = createNativeGitStatusStore();
    const first = { id: 't1', projectId: 'p1', mode: 'worktree', branch: 'feature' } as const;
    const second = { id: 't2', projectId: 'p1', mode: 'worktree', branch: 'feature' } as const;
    const firstKey = nativeGitBranchKey(first)!;
    const secondKey = nativeGitBranchKey(second)!;
    store.getState().replace([status('t1', firstKey, 10), status('t2', secondKey, 20)]);
    expect(nativeGitStatusForThread(store.getState(), first)?.linesAdded).toBe(10);
    expect(nativeGitStatusForThread(store.getState(), second)?.linesAdded).toBe(20);
  });

  test('clears every protected status index', () => {
    const store = createNativeGitStatusStore();
    store.getState().replace([status('t1', 'p1:master', 10)]);
    store.getState().clear();
    expect(store.getState().byThreadId).toEqual({});
    expect(store.getState().byBranchKey).toEqual({});
    expect(store.getState().threadToBranchKey).toEqual({});
  });
});
