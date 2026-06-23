import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { useSidebarActions } from '@/hooks/use-sidebar-actions';
import { useThreadStore } from '@/stores/thread-store';

const mockNavigate = vi.fn();
const mockDeleteThread = vi.fn().mockResolvedValue(undefined);
const mockDeleteScratchThread = vi.fn().mockResolvedValue(undefined);

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { title?: string }) => (opts?.title ? `${key}:${opts.title}` : key),
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/hooks/use-stable-navigate', () => ({
  useStableNavigate: () => mockNavigate,
}));

vi.mock('@/hooks/use-branch-switch', () => ({
  useBranchSwitch: () => ({
    ensureBranch: vi.fn(),
    branchSwitchDialog: null,
  }),
}));

const mockArchiveThread = vi.fn().mockResolvedValue(undefined);
const mockRenameThread = vi.fn().mockResolvedValue(undefined);
const mockPinThread = vi.fn().mockResolvedValue(undefined);

vi.mock('@/stores/project-store', () => {
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

vi.mock('@/lib/api', () => ({
  api: {
    removeWorktree: vi.fn(),
  },
}));

describe('useSidebarActions — delete selected thread from Activity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useThreadStore.setState({
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
    } as any);
  });

  test('navigates home before deleting a selected scratch thread', async () => {
    const scratchId = 'scratch-hola';
    useThreadStore.setState({
      selectedThreadId: scratchId,
      threadsById: {
        [scratchId]: {
          id: scratchId,
          projectId: '',
          title: 'hola',
          isScratch: true,
          status: 'completed',
        },
      },
      scratchThreadIds: [scratchId],
    } as any);

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
    useThreadStore.setState({
      selectedThreadId: threadId,
      threadsById: {
        [threadId]: {
          id: threadId,
          projectId: 'p1',
          title: 'Fix bug',
          status: 'completed',
        },
      },
      threadIdsByProject: { p1: [threadId] },
    } as any);

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
    expect(mockDeleteThread).toHaveBeenCalledWith(threadId, 'p1');
    expect(mockDeleteScratchThread).not.toHaveBeenCalled();
    expect(callOrder).toEqual(['navigate', 'delete']);
  });

  test('does not navigate when deleting a thread that is not selected', async () => {
    const threadId = 't2';
    useThreadStore.setState({
      selectedThreadId: 'other',
      threadsById: {
        [threadId]: {
          id: threadId,
          projectId: 'p1',
          title: 'Other',
          status: 'completed',
        },
      },
      threadIdsByProject: { p1: [threadId] },
    } as any);

    const { result } = renderHook(() => useSidebarActions());

    act(() => {
      result.current.handleDeleteThreadFromList(threadId, 'p1', 'Other', false);
    });

    await act(async () => {
      await result.current.handleDeleteThreadConfirm();
    });

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockDeleteThread).toHaveBeenCalledWith(threadId, 'p1');
  });
});

describe('useSidebarActions — archive, pin, and select', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useThreadStore.setState({
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
    } as any);
  });

  test('handleArchiveConfirm archives and navigates away when selected', async () => {
    useThreadStore.setState({
      selectedThreadId: 't1',
      threadsById: {
        t1: { id: 't1', projectId: 'p1', title: 'Fix', status: 'completed', mode: 'local' },
      },
    } as any);

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

  test('handleSelectThread navigates to thread route', async () => {
    useThreadStore.setState({
      threadsById: {
        t1: {
          id: 't1',
          projectId: 'p1',
          title: 'Thread',
          status: 'completed',
          mode: 'local',
        },
      },
    } as any);

    const { result } = renderHook(() => useSidebarActions());

    await act(async () => {
      await result.current.handleSelectThread('p1', 't1');
    });

    expect(mockNavigate).toHaveBeenCalledWith('/projects/p1/threads/t1');
  });
});
