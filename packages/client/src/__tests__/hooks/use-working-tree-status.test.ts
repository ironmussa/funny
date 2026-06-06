import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { useWorkingTreeStatus } from '@/hooks/use-working-tree-status';

const { useGitStatusForThreadMock, fetchForThread, fetchProjectStatus, storeState } = vi.hoisted(
  () => {
    const storeState = {
      statusByProject: {} as Record<string, unknown>,
      fetchForThread: vi.fn(),
      fetchProjectStatus: vi.fn(),
    };
    return {
      useGitStatusForThreadMock: vi.fn(),
      fetchForThread: storeState.fetchForThread,
      fetchProjectStatus: storeState.fetchProjectStatus,
      storeState,
    };
  },
);

vi.mock('@/stores/git-status-store', () => ({
  useGitStatusStore: Object.assign(
    (selector: (s: typeof storeState) => unknown) => selector(storeState),
    {
      getState: () => storeState,
    },
  ),
  useGitStatusForThread: useGitStatusForThreadMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
  storeState.statusByProject = {};
  useGitStatusForThreadMock.mockReturnValue(undefined);
});

describe('useWorkingTreeStatus', () => {
  test('thread with line changes is dirty and triggers a thread fetch', () => {
    useGitStatusForThreadMock.mockReturnValue({
      state: 'dirty',
      linesAdded: 3,
      linesDeleted: 0,
      dirtyFileCount: 1,
    });
    const { result } = renderHook(() => useWorkingTreeStatus('t1', null, true));
    expect(result.current.dirty).toBe(true);
    expect(result.current.status).toMatchObject({ linesAdded: 3 });
    expect(fetchForThread).toHaveBeenCalledWith('t1');
    expect(fetchProjectStatus).not.toHaveBeenCalled();
  });

  test('clean project working tree is not dirty', () => {
    storeState.statusByProject = {
      p1: { state: 'clean', linesAdded: 0, linesDeleted: 0, dirtyFileCount: 0 },
    };
    const { result } = renderHook(() => useWorkingTreeStatus(undefined, 'p1', true));
    expect(result.current.dirty).toBe(false);
    expect(fetchProjectStatus).toHaveBeenCalledWith('p1');
  });

  test('project dirty by untracked-file count alone (no line stats) is still dirty', () => {
    storeState.statusByProject = {
      p1: { state: 'dirty', linesAdded: 0, linesDeleted: 0, dirtyFileCount: 2 },
    };
    const { result } = renderHook(() => useWorkingTreeStatus(undefined, 'p1', true));
    expect(result.current.dirty).toBe(true);
  });

  test('disabled does not fetch', () => {
    renderHook(() => useWorkingTreeStatus('t1', null, false));
    expect(fetchForThread).not.toHaveBeenCalled();
    expect(fetchProjectStatus).not.toHaveBeenCalled();
  });
});
