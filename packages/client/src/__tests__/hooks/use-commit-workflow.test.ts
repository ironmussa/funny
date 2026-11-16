import { act, renderHook } from '@testing-library/react';
import { ok } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const { gitApi, refreshAllLoadedThreads } = vi.hoisted(() => ({
  gitApi: { startWorkflow: vi.fn(), projectStartWorkflow: vi.fn() },
  refreshAllLoadedThreads: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/toast-error', () => ({ toastError: vi.fn() }));
vi.mock('@/lib/api/git', () => ({ gitApi }));
vi.mock('@/lib/api/projects', () => ({ projectsApi: { listBranches: vi.fn() } }));
vi.mock('@/stores/draft-store', () => ({ useDraftStore: () => ({ clearCommitDraft: vi.fn() }) }));
vi.mock('@/stores/thread-store', () => ({
  useThreadStore: {
    getState: () => ({ refreshActiveThread: vi.fn(), refreshAllLoadedThreads }),
  },
}));

import { useCommitWorkflow } from '@/hooks/use-commit-workflow';
import { useCommitProgressStore } from '@/stores/commit-progress-store';

function args(threadId: string, refresh = vi.fn()) {
  return {
    hasGitContext: true,
    effectiveThreadId: threadId,
    projectModeId: null,
    threadProjectId: 'p1',
    selectedProjectId: 'p1',
    summaries: [],
    checkedFiles: new Set<string>(),
    commitTitle: '',
    commitBody: '',
    draftId: null,
    setCommitTitle: vi.fn(),
    setCommitBody: vi.fn(),
    baseBranch: 'main',
    threadBranch: 'feature',
    currentBranch: 'feature',
    refresh,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useCommitProgressStore.setState({ activeCommits: {}, settled: {}, failedWorkflow: null });
  gitApi.startWorkflow.mockResolvedValue(ok({ workflowId: 'wf-1' }));
});

describe('useCommitWorkflow', () => {
  test('switching away from a thread mid-workflow is not taken for the workflow ending', () => {
    const refresh = vi.fn();
    useCommitProgressStore.getState().startCommit('t1', 'Merging', [], 'merge', 'wf-1');
    const { result, rerender } = renderHook((p: ReturnType<typeof args>) => useCommitWorkflow(p), {
      initialProps: args('t1', refresh),
    });

    rerender(args('t2', refresh));

    // A "finished" here closed the review pane on a clean thread and refreshed
    // every loaded thread.
    expect(result.current.justCompletedWorkflowRef.current).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    expect(refreshAllLoadedThreads).not.toHaveBeenCalled();
  });

  test('a workflow that fails before it starts frees the buttons', async () => {
    const { result } = renderHook(() => useCommitWorkflow(args('t1')));
    await act(async () => {
      await result.current.handlePushOnly();
    });
    expect(result.current.pushInProgress).toBe(true);

    // The runner reports `failed` without ever sending `started`.
    act(() => useCommitProgressStore.getState().finishCommit('t1', 'wf-1', 'push'));

    expect(result.current.pushInProgress).toBe(false);
    expect(result.current.justCompletedWorkflowRef.current).toBe(true);
  });

  test('a workflow ending clears the flags and refreshes, once', async () => {
    const refresh = vi.fn();
    const { result } = renderHook(() => useCommitWorkflow(args('t1', refresh)));
    await act(async () => {
      await result.current.handlePushOnly();
    });
    act(() => useCommitProgressStore.getState().startCommit('t1', 'Pushing', [], 'push', 'wf-1'));
    act(() => useCommitProgressStore.getState().finishCommit('t1', 'wf-1'));

    expect(result.current.pushInProgress).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
