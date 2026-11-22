import { beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import { act, renderHook } from '@testing-library/react';

import { buildThread, withThreadIndex } from '@/data/threads/testing';
import { useSidebarActions } from '@/hooks/use-sidebar-actions';
import { useThreadStore } from '@/stores/thread-store';

const mockNavigate = vi.fn();
const mockEnsureBranch = vi.fn().mockResolvedValue(false);
const mockDeleteThread = vi.fn().mockResolvedValue(undefined);
const mockDeleteScratchThread = vi.fn().mockResolvedValue(undefined);

mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { title?: string }) => (opts?.title ? `${key}:${opts.title}` : key),
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

mock.module('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

mock.module('@/hooks/use-stable-navigate', () => ({
  useStableNavigate: () => mockNavigate,
}));

mock.module('@/hooks/use-branch-switch', () => ({
  useBranchSwitch: () => ({
    ensureBranch: mockEnsureBranch,
    branchSwitchDialog: null,
  }),
}));

const mockArchiveThread = vi.fn().mockResolvedValue(undefined);
const mockRenameThread = vi.fn().mockResolvedValue(undefined);
const mockPinThread = vi.fn().mockResolvedValue(undefined);

mock.module('@/stores/project-store', () => {
  const projectStore = {
    renameProject: vi.fn(),
    deleteProject: vi.fn(),
    closeProject: vi.fn(),
    reopenProject: vi.fn(),
    expandedProjects: new Set<string>(),
    selectedProjectId: null,
    toggleProject: vi.fn(),
    selectProject: vi.fn(),
  };
  const useProjectStore = (selector: (s: any) => unknown) => selector(projectStore);
  useProjectStore.getState = () => projectStore;
  return { useProjectStore };
});

const { mockRemoveWorktree } = (() => ({ mockRemoveWorktree: vi.fn() }))();
mock.module('@/lib/api', () => ({
  api: {
    removeWorktree: mockRemoveWorktree,
  },
}));

describe('useSidebarActions — delete selected thread from Activity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useThreadStore.setState(
      withThreadIndex({
        selectedThreadId: null,
        activeThread: null,
        threadsById: {},
        threadIdsByProject: {},
        scratchThreadIds: [],
        deleteThread: mockDeleteThread,
        deleteScratchThread: mockDeleteScratchThread,
        archiveThread: mockArchiveThread,
        renameThread: mockRenameThread,
        pinThread: mockPinThread,
      }),
    );
  });

  test('navigates home before deleting a selected scratch thread', async () => {
    const scratchId = 'scratch-hola';
    useThreadStore.setState(
      withThreadIndex({
        selectedThreadId: scratchId,
        threadsById: {
          [scratchId]: buildThread({
            id: scratchId,
            projectId: '',
            title: 'hola',
            isScratch: true,
          }),
        },
        scratchThreadIds: [scratchId],
      }),
    );

    const { result } = renderHook(() => useSidebarActions());
    const callOrder: string[] = [];
    mockNavigate.mockImplementation(() => callOrder.push('navigate'));
    mockDeleteScratchThread.mockImplementation(async () => {
      callOrder.push('delete');
    });

    act(() => {
      result.current.handleDeleteThreadFromList(scratchId, '', 'hola', false);
    });

    await act(async () => {
      await result.current.handleDeleteThreadConfirm();
    });

    expect(mockNavigate).toHaveBeenCalledWith('/');
    expect(mockDeleteScratchThread).toHaveBeenCalledWith(scratchId);
    expect(mockDeleteThread).not.toHaveBeenCalled();
    expect(callOrder).toEqual(['navigate', 'delete']);
  });

  test('navigates to project before deleting a selected project thread', async () => {
    const threadId = 't1';
    useThreadStore.setState(
      withThreadIndex({
        selectedThreadId: threadId,
        threadsById: {
          [threadId]: buildThread({ id: threadId, title: 'Fix bug' }),
        },
        threadIdsByProject: { p1: [threadId] },
      }),
    );

    const { result } = renderHook(() => useSidebarActions());
    const callOrder: string[] = [];
    mockNavigate.mockImplementation(() => callOrder.push('navigate'));
    mockDeleteThread.mockImplementation(async () => {
      callOrder.push('delete');
    });

    act(() => {
      result.current.handleDeleteThreadFromList(threadId, 'p1', 'Fix bug', false);
    });

    await act(async () => {
      await result.current.handleDeleteThreadConfirm();
    });

    expect(mockNavigate).toHaveBeenCalledWith('/projects/p1');
    expect(mockDeleteThread).toHaveBeenCalledWith(threadId, 'p1', { deleteBranch: undefined });
    expect(mockDeleteScratchThread).not.toHaveBeenCalled();
    expect(callOrder).toEqual(['navigate', 'delete']);
  });

  test('does not navigate when deleting a thread that is not selected', async () => {
    const threadId = 't2';
    useThreadStore.setState(
      withThreadIndex({
        selectedThreadId: 'other',
        threadsById: {
          [threadId]: buildThread({ id: threadId, title: 'Other' }),
        },
        threadIdsByProject: { p1: [threadId] },
      }),
    );

    const { result } = renderHook(() => useSidebarActions());

    act(() => {
      result.current.handleDeleteThreadFromList(threadId, 'p1', 'Other', false);
    });

    await act(async () => {
      await result.current.handleDeleteThreadConfirm();
    });

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockDeleteThread).toHaveBeenCalledWith(threadId, 'p1', { deleteBranch: undefined });
  });

  test('deletes a worktree thread in one request, without a separate worktree removal', async () => {
    // Regression: a prior DELETE /worktrees held the row on screen for the whole
    // (slow) removal; a second click raced it and the first delete then 404ed.
    const threadId = 'wt1';
    useThreadStore.setState(
      withThreadIndex({
        selectedThreadId: null,
        threadsById: {
          [threadId]: {
            id: threadId,
            projectId: 'p1',
            title: 'hola',
            status: 'completed',
            mode: 'worktree',
            branch: 'funny/hola',
            worktreePath: '/tmp/.funny-worktrees/funny/funny-hola',
          },
        },
        threadIdsByProject: { p1: [threadId] },
      } as any),
    );

    const { result } = renderHook(() => useSidebarActions());

    act(() => {
      result.current.handleDeleteThreadFromList(threadId, 'p1', 'hola', true);
    });

    await act(async () => {
      await result.current.handleDeleteThreadConfirm();
    });

    expect(mockRemoveWorktree).not.toHaveBeenCalled();
    expect(mockDeleteThread).toHaveBeenCalledWith(threadId, 'p1', { deleteBranch: undefined });
  });

  test("passes the dialog's delete-branch choice to the delete", async () => {
    const threadId = 'wt2';
    useThreadStore.setState(
      withThreadIndex({
        selectedThreadId: null,
        threadsById: {
          [threadId]: { id: threadId, projectId: 'p1', title: 'x', mode: 'worktree' },
        },
        threadIdsByProject: { p1: [threadId] },
      } as any),
    );
    const { result } = renderHook(() => useSidebarActions());
    act(() => {
      result.current.handleDeleteThreadFromList(threadId, 'p1', 'x', true);
    });
    await act(async () => {
      await result.current.handleDeleteThreadConfirm({ deleteBranch: true });
    });
    expect(mockDeleteThread).toHaveBeenCalledWith(threadId, 'p1', { deleteBranch: true });
  });
});

describe('useSidebarActions — archive, pin, and select', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useThreadStore.setState(
      withThreadIndex({
        selectedThreadId: null,
        activeThread: null,
        threadsById: {},
        threadIdsByProject: {},
        scratchThreadIds: [],
        deleteThread: mockDeleteThread,
        deleteScratchThread: mockDeleteScratchThread,
        archiveThread: mockArchiveThread,
        renameThread: mockRenameThread,
        pinThread: mockPinThread,
        selectThread: vi.fn(),
      }),
    );
  });

  test('handleArchiveConfirm archives and navigates away when selected', async () => {
    useThreadStore.setState(
      withThreadIndex({
        selectedThreadId: 't1',
        threadsById: {
          t1: buildThread({ title: 'Fix' }),
        },
      }),
    );

    const { result } = renderHook(() => useSidebarActions());

    act(() => {
      result.current.handleArchiveThreadFromList('t1', 'p1', 'Fix', false);
    });

    await act(async () => {
      await result.current.handleArchiveConfirm();
    });

    expect(mockArchiveThread).toHaveBeenCalledWith('t1', 'p1');
    expect(mockNavigate).toHaveBeenCalledWith('/projects/p1');
  });

  test('handlePinThread delegates to thread store', () => {
    const { result } = renderHook(() => useSidebarActions());

    act(() => {
      result.current.handlePinThread('p1', 't1', true);
    });

    expect(mockPinThread).toHaveBeenCalledWith('t1', 'p1', true);
  });

  test('opens a local thread even when its branch cannot be checked out', async () => {
    useThreadStore.setState(
      withThreadIndex({
        threadsById: {
          t1: buildThread({ title: 'Thread', branch: 'deleted-branch' }),
        },
      }),
    );

    const { result } = renderHook(() => useSidebarActions());

    await act(async () => {
      await result.current.handleSelectThread('p1', 't1');
    });

    expect(mockNavigate).toHaveBeenCalledWith('/projects/p1/threads/t1');
    expect(useThreadStore.getState().selectThread).toHaveBeenCalledWith('t1');
    expect(mockEnsureBranch).not.toHaveBeenCalled();
  });
});
