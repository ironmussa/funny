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
