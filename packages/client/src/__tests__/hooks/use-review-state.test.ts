import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { useReviewState } from '@/hooks/use-review-state';

// ── Peer-hook spies (stable across renders) ─────────────────────
const { refreshSpy, abortSpy } = vi.hoisted(() => ({
  refreshSpy: vi.fn(),
  abortSpy: vi.fn(),
}));

vi.mock('@/hooks/use-diff-data', () => ({
  useDiffData: () => ({
    diffCache: new Map(),
    loadingDiff: null,
    loading: false,
    loadError: false,
    truncatedInfo: { total: 0, truncated: false },
    setDiffCache: vi.fn(),
    setLoadError: vi.fn(),
    abortRef: { current: { abort: abortSpy } },
    needsRefreshRef: { current: false },
    refresh: refreshSpy,
    loadDiffForFile: vi.fn(),
    requestFullDiff: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-commit-draft', () => ({
  useCommitDraft: () => ({
    commitTitle: '',
    commitBody: '',
    setCommitTitle: vi.fn(),
    setCommitBody: vi.fn(),
    commitTitleRef: { current: null },
    commitBodyRef: { current: null },
  }),
}));

vi.mock('@/hooks/use-generate-commit-msg', () => ({
  useGenerateCommitMsg: () => ({
    generatingMsg: false,
    handleGenerateCommitMsg: vi.fn(),
    abortGenerate: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-publish-state', () => ({
  usePublishState: () => ({
    remoteUrl: null,
    publishDialogOpen: false,
    setPublishDialogOpen: vi.fn(),
    handlePublishSuccess: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-file-tree-state', () => ({
  useFileTreeState: () => ({
    filteredDiffs: [],
    collapsedFolders: new Set(),
    toggleFolder: vi.fn(),
    handleCollapseAllFolders: vi.fn(),
    handleExpandAllFolders: vi.fn(),
    hasFolders: false,
    allFoldersCollapsed: false,
    expandedSubmodules: new Set(),
    submoduleExpansions: new Map(),
    toggleSubmodule: vi.fn(),
    resolveSubmoduleEntry: vi.fn(),
    treeRows: [],
    visibleFiles: [],
    visiblePaths: new Set(),
  }),
}));

vi.mock('@/hooks/use-stash-state', () => ({
  useStashState: () => ({ stashEntries: [], refreshStashList: vi.fn() }),
}));

vi.mock('@/hooks/use-commit-workflow', () => ({
  useCommitWorkflow: () => ({
    selectedAction: 'commit',
    setSelectedAction: vi.fn(),
    actionInProgress: false,
    setActionInProgress: vi.fn(),
    pushInProgress: false,
    mergeInProgress: false,
    prInProgress: false,
    prDialog: null,
    setPrDialog: vi.fn(),
    mergeDialog: null,
    setMergeDialog: vi.fn(),
    hasRebaseConflict: false,
    setHasRebaseConflict: vi.fn(),
    justCompletedWorkflowRef: { current: false },
    commitInProgress: false,
    commitEntry: null,
    commitProgressId: null,
    handleCommitAction: vi.fn(),
    handlePushOnly: vi.fn(),
    openMergeDialog: vi.fn(),
    handleMergeWithTarget: vi.fn(),
    handleCreatePROnly: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-review-actions', () => ({
  useReviewActions: () => ({}),
}));

function baseArgs(currentBranch: string | undefined) {
  return {
    effectiveThreadId: undefined,
    projectModeId: 'p1',
    hasGitContext: true,
    gitContextKey: 'p1',
    threadProjectId: 'p1',
    selectedProjectId: 'p1',
    baseBranch: 'main',
    threadBranch: undefined,
    currentBranch,
    basePath: '/repo',
    isAgentRunning: false,
    gitStatus: undefined,
    unpushedCommitCount: 0,
    remoteCheckProjectId: 'p1',
    reviewPaneOpen: true,
    reviewSubTab: 'changes' as const,
    setReviewPaneOpen: vi.fn(),
    setConfirmDialog: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useReviewState reset effect', () => {
  test('does not re-reset/refresh when the branch name merely hydrates after mount', async () => {
    const { rerender } = renderHook(
      (branch: string | undefined) => useReviewState(baseArgs(branch)),
      {
        initialProps: undefined as string | undefined,
      },
    );

    // Mount: one reset → one refresh (context became defined).
    await waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));
    abortSpy.mockClear();

    // `currentBranch` resolves async from undefined → "main" within the SAME
    // context. This is not a real checkout, so the destructive reset must be
    // skipped — otherwise it clears a freshly-loaded summary and races a second
    // refresh, leaving the Changes tab stuck on "No changes".
    rerender('main');
    await Promise.resolve();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(abortSpy).not.toHaveBeenCalled();

    // A genuine checkout (value → value) still resets + refreshes.
    rerender('feature/x');
    await waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(2));
    expect(abortSpy).toHaveBeenCalled();
  });
});
