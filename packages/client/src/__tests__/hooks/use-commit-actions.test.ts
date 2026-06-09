import { act, renderHook } from '@testing-library/react';
import { err, ok } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { useCommitActions } from '@/hooks/use-commit-actions';

const { api, toastSuccess, toastErrorFn, fetchForThread, fetchProjectStatus } = vi.hoisted(() => ({
  api: {
    checkoutCommit: vi.fn(),
    projectCheckoutCommit: vi.fn(),
    revertCommit: vi.fn(),
    projectRevertCommit: vi.fn(),
    resetHard: vi.fn(),
    projectResetHard: vi.fn(),
    cherryPick: vi.fn(),
    projectCherryPick: vi.fn(),
    pushBranch: vi.fn(),
    projectPushBranch: vi.fn(),
    createBranch: vi.fn(),
    projectCreateBranch: vi.fn(),
  },
  toastSuccess: vi.fn(),
  toastErrorFn: vi.fn(),
  fetchForThread: vi.fn(),
  fetchProjectStatus: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('sonner', () => ({ toast: { success: toastSuccess } }));
vi.mock('@/lib/toast-error', () => ({ toastError: toastErrorFn }));
vi.mock('@/stores/git-status-store', () => ({
  useGitStatusStore: { getState: () => ({ fetchForThread, fetchProjectStatus }) },
}));
vi.mock('@/lib/api', () => ({ api }));

beforeEach(() => {
  vi.clearAllMocks();
  Object.values(api).forEach((fn) => fn.mockResolvedValue(ok({})));
});

describe('useCommitActions', () => {
  test('request → confirm runs the thread checkout API, toasts, refreshes, and fires onSuccess', async () => {
    const onAfterAction = vi.fn();
    const onSuccess = vi.fn();
    const { result } = renderHook(() =>
      useCommitActions({ effectiveThreadId: 't1', projectModeId: null, onAfterAction, onSuccess }),
    );

    act(() => result.current.request('checkout', 'deadbeef'));
    expect(result.current.pending).toEqual({ kind: 'checkout', hash: 'deadbeef' });

    await act(async () => {
      await result.current.confirm();
    });

    expect(api.checkoutCommit).toHaveBeenCalledWith('t1', 'deadbeef');
    expect(api.projectCheckoutCommit).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith('checkout');
    expect(fetchForThread).toHaveBeenCalledWith('t1', true);
    expect(onAfterAction).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBeNull();
  });

  test('reset in project context calls the project hard-reset API', async () => {
    const { result } = renderHook(() =>
      useCommitActions({ projectModeId: 'p9', onAfterAction: vi.fn() }),
    );
    act(() => result.current.request('reset', 'cafe'));
    await act(async () => {
      await result.current.confirm();
    });
    expect(api.projectResetHard).toHaveBeenCalledWith('p9', 'cafe');
    expect(fetchProjectStatus).toHaveBeenCalledWith('p9', true);
  });

  test('failure path surfaces toastError and does NOT call onSuccess', async () => {
    api.revertCommit.mockResolvedValue(err({ message: 'nope' }));
    const onSuccess = vi.fn();
    const { result } = renderHook(() =>
      useCommitActions({
        effectiveThreadId: 't1',
        projectModeId: null,
        onAfterAction: vi.fn(),
        onSuccess,
      }),
    );
    act(() => result.current.request('revert', 'abc'));
    await act(async () => {
      await result.current.confirm();
    });
    expect(toastErrorFn).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  test('cancel clears the pending action without calling any API', () => {
    const { result } = renderHook(() =>
      useCommitActions({ projectModeId: 'p1', onAfterAction: vi.fn() }),
    );
    act(() => result.current.request('reset', 'x'));
    expect(result.current.pending).not.toBeNull();
    act(() => result.current.cancel());
    expect(result.current.pending).toBeNull();
    expect(api.projectResetHard).not.toHaveBeenCalled();
  });

  test('request is a no-op without git context (no thread, no project)', () => {
    const { result } = renderHook(() =>
      useCommitActions({ projectModeId: null, onAfterAction: vi.fn() }),
    );
    act(() => result.current.request('checkout', 'x'));
    expect(result.current.pending).toBeNull();
    expect(result.current.hasGitContext).toBe(false);
  });

  test('cherry-pick goes through the confirm flow and calls the thread cherry-pick API', async () => {
    const onAfterAction = vi.fn();
    const { result } = renderHook(() =>
      useCommitActions({ effectiveThreadId: 't1', projectModeId: null, onAfterAction }),
    );
    act(() => result.current.request('cherry-pick', 'feedface'));
    expect(result.current.pending).toEqual({ kind: 'cherry-pick', hash: 'feedface' });
    await act(async () => {
      await result.current.confirm();
    });
    expect(api.cherryPick).toHaveBeenCalledWith('t1', 'feedface');
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(fetchForThread).toHaveBeenCalledWith('t1', true);
    expect(result.current.pending).toBeNull();
  });

  test('pushBranch runs immediately (no confirm) and calls the project push-branch API', async () => {
    const onAfterAction = vi.fn();
    const { result } = renderHook(() => useCommitActions({ projectModeId: 'p9', onAfterAction }));
    await act(async () => {
      await result.current.pushBranch('feat/x');
    });
    expect(api.projectPushBranch).toHaveBeenCalledWith('p9', 'feat/x');
    expect(result.current.pending).toBeNull();
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(fetchProjectStatus).toHaveBeenCalledWith('p9', true);
    expect(onAfterAction).toHaveBeenCalledTimes(1);
  });

  test('pushBranch surfaces toastError on failure', async () => {
    api.pushBranch.mockResolvedValue(err({ message: 'rejected' }));
    const { result } = renderHook(() =>
      useCommitActions({ effectiveThreadId: 't1', projectModeId: null, onAfterAction: vi.fn() }),
    );
    await act(async () => {
      await result.current.pushBranch('feat/x');
    });
    expect(api.pushBranch).toHaveBeenCalledWith('t1', 'feat/x');
    expect(toastErrorFn).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  test('createBranch runs immediately and calls the thread create-branch API with start point', async () => {
    const { result } = renderHook(() =>
      useCommitActions({ effectiveThreadId: 't1', projectModeId: null, onAfterAction: vi.fn() }),
    );
    await act(async () => {
      await result.current.createBranch('feat/new', 'deadbeef');
    });
    expect(api.createBranch).toHaveBeenCalledWith('t1', 'feat/new', 'deadbeef');
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(fetchForThread).toHaveBeenCalledWith('t1', true);
  });

  test('pushBranch / createBranch are no-ops without git context', async () => {
    const { result } = renderHook(() =>
      useCommitActions({ projectModeId: null, onAfterAction: vi.fn() }),
    );
    await act(async () => {
      await result.current.pushBranch('feat/x');
      await result.current.createBranch('feat/y', 'abc');
    });
    expect(api.pushBranch).not.toHaveBeenCalled();
    expect(api.projectPushBranch).not.toHaveBeenCalled();
    expect(api.createBranch).not.toHaveBeenCalled();
    expect(api.projectCreateBranch).not.toHaveBeenCalled();
  });
});
