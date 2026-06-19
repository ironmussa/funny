import type { FileDiffSummary } from '@funny/shared';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';

import type { ConfirmDialogState } from '@/components/review-pane/ReviewDialogs';
import { useCommitDraft } from '@/hooks/use-commit-draft';
import { useCommitWorkflow } from '@/hooks/use-commit-workflow';
import { useDiffData } from '@/hooks/use-diff-data';
import { useFileTreeState } from '@/hooks/use-file-tree-state';
import { useGenerateCommitMsg } from '@/hooks/use-generate-commit-msg';
import { usePublishState } from '@/hooks/use-publish-state';
import { useReviewActions } from '@/hooks/use-review-actions';
import { useStashState } from '@/hooks/use-stash-state';
import type { ProjectGitStatus } from '@/stores/git-status-store';
import type { ReviewSubTab } from '@/stores/ui-store';

interface UseReviewStateArgs {
  // Identity / context
  effectiveThreadId: string | undefined;
  projectModeId: string | null;
  hasGitContext: boolean;
  gitContextKey: string | null;
  threadProjectId: string | undefined;
  selectedProjectId: string | null;

  // Branch
  baseBranch: string | undefined;
  threadBranch: string | undefined;
  currentBranch: string | undefined;

  // Path / status
  basePath: string;
  isAgentRunning: boolean;
  gitStatus: ProjectGitStatus | undefined;
  unpushedCommitCount: number;
  remoteCheckProjectId: string | null;

  // UI flags from store
  reviewPaneOpen: boolean;
  reviewSubTab: ReviewSubTab;

  // Outbound callbacks (owned by ReviewPane)
  setReviewPaneOpen: (open: boolean) => void;
  setConfirmDialog: Dispatch<SetStateAction<ConfirmDialogState | null>>;
}

/**
 * Facade that orchestrates the 8 review-pane hooks plus the local file-selection
 * state and the three context-lifecycle effects. ReviewPane.tsx imports this one
 * hook instead of wiring each piece by hand.
 */
export function useReviewState(args: UseReviewStateArgs) {
  const {
    effectiveThreadId,
    projectModeId,
    hasGitContext,
    gitContextKey,
    threadProjectId,
    selectedProjectId,
    baseBranch,
    threadBranch,
    currentBranch,
    basePath,
    isAgentRunning,
    gitStatus,
    unpushedCommitCount,
    remoteCheckProjectId,
    reviewPaneOpen,
    reviewSubTab,
    setReviewPaneOpen,
    setConfirmDialog,
  } = args;

  // ── File-selection state (consumed by every hook + the orchestrator) ──
  const [summaries, setSummaries] = useState<FileDiffSummary[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [fileSearch, setFileSearch] = useState('');
  const [fileSearchCaseSensitive, setFileSearchCaseSensitive] = useState(false);
  const [checkedFiles, setCheckedFiles] = useState<Set<string>>(new Set());

  const draftId = effectiveThreadId || projectModeId;

  const { commitTitle, commitBody, setCommitTitle, setCommitBody, commitTitleRef, commitBodyRef } =
    useCommitDraft(draftId);

  const { generatingMsg, handleGenerateCommitMsg, abortGenerate } = useGenerateCommitMsg({
    hasGitContext,
    draftId,
    effectiveThreadId,
    projectModeId,
    setCommitTitle,
    setCommitBody,
  });

  const { remoteUrl, publishDialogOpen, setPublishDialogOpen, handlePublishSuccess } =
    usePublishState({
      remoteCheckProjectId,
      hasRemoteBranch: gitStatus?.hasRemoteBranch,
    });

  const isOnDifferentBranch =
    !!effectiveThreadId && !!baseBranch && !!threadBranch && threadBranch !== baseBranch;

  const tree = useFileTreeState({
    summaries,
    fileSearch,
    fileSearchCaseSensitive,
    effectiveThreadId,
    projectModeId,
  });
  const {
    filteredDiffs,
    collapsedFolders,
    toggleFolder,
    handleCollapseAllFolders,
    handleExpandAllFolders,
    hasFolders,
    allFoldersCollapsed,
    expandedSubmodules,
    submoduleExpansions,
    toggleSubmodule,
    resolveSubmoduleEntry,
    treeRows,
    visibleFiles,
    visiblePaths,
  } = tree;

  const diffData = useDiffData({
    hasGitContext,
    effectiveThreadId,
    projectModeId,
    selectedFile,
    expandedFile,
    reviewPaneOpen,
    summaries,
    setSummaries,
    submoduleExpansions,
    setSelectedFile,
    setCheckedFiles,
    dirtyFileCount: gitStatus?.dirtyFileCount,
    linesAdded: gitStatus?.linesAdded,
    linesDeleted: gitStatus?.linesDeleted,
  });
  const {
    diffCache,
    loadingDiff,
    loading,
    loadError,
    truncatedInfo,
    setDiffCache,
    setLoadError,
    abortRef,
    needsRefreshRef,
    refresh,
    loadDiffForFile,
    requestFullDiff,
  } = diffData;

  const stash = useStashState({
    hasGitContext,
    effectiveThreadId,
    projectModeId,
    currentBranch,
    abortRef,
    reviewPaneOpen,
    reviewSubTab,
    refresh,
    gitContextKey: gitContextKey ?? '',
  });

  const wf = useCommitWorkflow({
    hasGitContext,
    effectiveThreadId,
    projectModeId,
    threadProjectId,
    selectedProjectId,
    summaries,
    checkedFiles,
    commitTitle,
    commitBody,
    draftId,
    setCommitTitle,
    setCommitBody,
    baseBranch,
    threadBranch,
    currentBranch,
    refresh,
  });
  const {
    selectedAction,
    setSelectedAction,
    actionInProgress,
    setActionInProgress,
    pushInProgress,
    mergeInProgress,
    prInProgress,
    prDialog,
    setPrDialog,
    mergeDialog,
    setMergeDialog,
    hasRebaseConflict,
    setHasRebaseConflict,
    justCompletedWorkflowRef,
    commitInProgress,
    commitEntry,
    commitProgressId,
    handleCommitAction,
    handlePushOnly,
    openMergeDialog,
    handleMergeWithTarget,
    handleCreatePROnly,
  } = wf;

  const actions = useReviewActions({
    hasGitContext,
    effectiveThreadId,
    projectModeId,
    summaries,
    checkedFiles,
    expandedFile,
    selectedFile,
    baseBranch,
    basePath,
    refresh,
    loadDiffForFile,
    setDiffCache,
    setHasRebaseConflict,
    setConfirmDialog,
    refreshStashList: stash.refreshStashList,
  });
  const {
    pullInProgress,
    fetchInProgress,
    stashInProgress,
    resetInProgress,
    patchStagingInProgress,
    pullStrategyDialog,
    setPullStrategyDialog,
    fileSelectionState,
    setFileSelectionState,
    selectAllSignal,
    setSelectAllSignal,
    deselectAllSignal,
    setDeselectAllSignal,
    handleRevertFile,
    executeRevert,
    handleDiscardAll,
    handleDiscardFolder,
    executeDiscardAll,
    handleIgnoreFiles,
    executeIgnoreFiles,
    handleIgnore,
    executeResetSoft,
    handleStageFile,
    handleUnstageFile,
    handleStageSelected,
    handleUnstageAll,
    handleStagePatch,
    handleSelectionStateChange,
    handleResolveConflict,
    handleAskAgentResolve,
    handleOpenInEditorConflict,
    handlePull,
    handlePullStrategyChosen,
    handleFetchOrigin,
    handleStash,
    handleStashSelected,
    handleCopyPath,
    handleOpenDirectory,
  } = actions;

  // ── Auto-close pane when branch goes fully clean after a workflow ──
  useEffect(() => {
    if (
      justCompletedWorkflowRef.current &&
      !loading &&
      summaries.length === 0 &&
      stash.stashEntries.length === 0 &&
      unpushedCommitCount === 0 &&
      !hasRebaseConflict
    ) {
      justCompletedWorkflowRef.current = false;
      setReviewPaneOpen(false);
    }
  }, [
    loading,
    summaries.length,
    stash.stashEntries.length,
    unpushedCommitCount,
    hasRebaseConflict,
    setReviewPaneOpen,
    justCompletedWorkflowRef,
  ]);

  // Track the last-seen context + branch so the reset effect can tell a real
  // branch SWITCH (checkout) apart from the initial async hydration of the
  // branch name. `undefined` sentinel means "not seen yet".
  const prevGitContextKeyRef = useRef<string | null | undefined>(undefined);
  const prevCurrentBranchRef = useRef<string | undefined>(undefined);

  // ── Reset on context change (thread/project switch or branch checkout) ──
  useEffect(() => {
    const contextChanged = gitContextKey !== prevGitContextKeyRef.current;
    const branchChanged = currentBranch !== prevCurrentBranchRef.current;
    // `currentBranch` comes from `branchByProject`, which hydrates asynchronously
    // AFTER mount (undefined → "main"). That first resolution is NOT a real
    // checkout — the worktree was always on that branch, we just learned its
    // name — so the destructive reset below would clear a freshly-loaded summary
    // and re-fire a refresh that races the mount refresh, leaving the Changes tab
    // stuck on "No changes" until a manual refresh. Skip it. A genuine checkout
    // goes value→value within the same context and still resets.
    const isInitialBranchHydration =
      !contextChanged &&
      branchChanged &&
      prevCurrentBranchRef.current === undefined &&
      currentBranch !== undefined;

    prevGitContextKeyRef.current = gitContextKey;
    prevCurrentBranchRef.current = currentBranch;

    if (isInitialBranchHydration) return;

    abortRef.current?.abort();
    abortGenerate();

    setSummaries([]);
    setDiffCache(new Map());
    setSelectedFile(null);
    setCheckedFiles(new Set());
    setFileSearch('');
    setHasRebaseConflict(false);
    setLoadError(false);
    setSelectedAction('commit');

    if (reviewPaneOpen) {
      refresh();
    } else {
      needsRefreshRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset+refresh on context change only
  }, [gitContextKey, currentBranch]);

  // ── Reset selectedAction if "commit-pr" picked but PR already exists ──
  useEffect(() => {
    if (selectedAction === 'commit-pr' && gitStatus?.prNumber) {
      setSelectedAction('commit');
    }
  }, [selectedAction, gitStatus?.prNumber, setSelectedAction]);

  // ── Derived selection counters ──
  const checkedCount = [...checkedFiles].filter((p) => visiblePaths.has(p)).length;
  const totalCount = visibleFiles.length;

  const toggleFile = useCallback((path: string) => {
    setCheckedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    const targetPaths = visiblePaths;
    const allChecked = [...targetPaths].every((p) => checkedFiles.has(p));
    if (allChecked) {
      setCheckedFiles((prev) => {
        const next = new Set(prev);
        for (const p of targetPaths) next.delete(p);
        return next;
      });
    } else {
      setCheckedFiles((prev) => new Set([...prev, ...targetPaths]));
    }
  }, [visiblePaths, checkedFiles]);

  const canCommit =
    checkedFiles.size > 0 &&
    commitTitle.trim().length > 0 &&
    !actionInProgress &&
    (effectiveThreadId ? true : !isAgentRunning);

  return {
    // Selection state
    summaries,
    setSummaries,
    selectedFile,
    setSelectedFile,
    expandedFile,
    setExpandedFile,
    fileSearch,
    setFileSearch,
    fileSearchCaseSensitive,
    setFileSearchCaseSensitive,
    checkedFiles,
    setCheckedFiles,
    checkedCount,
    totalCount,
    toggleFile,
    toggleAll,
    canCommit,
    isOnDifferentBranch,

    // Commit draft
    commitTitle,
    commitBody,
    setCommitTitle,
    setCommitBody,
    commitTitleRef,
    commitBodyRef,

    // Commit message generation
    generatingMsg,
    handleGenerateCommitMsg,
    abortGenerate,

    // Publish
    remoteUrl,
    publishDialogOpen,
    setPublishDialogOpen,
    handlePublishSuccess,

    // File tree
    filteredDiffs,
    collapsedFolders,
    toggleFolder,
    handleCollapseAllFolders,
    handleExpandAllFolders,
    hasFolders,
    allFoldersCollapsed,
    expandedSubmodules,
    submoduleExpansions,
    toggleSubmodule,
    resolveSubmoduleEntry,
    treeRows,
    visibleFiles,
    visiblePaths,

    // Diff data
    diffCache,
    loadingDiff,
    loading,
    loadError,
    truncatedInfo,
    setDiffCache,
    setLoadError,
    abortRef,
    needsRefreshRef,
    refresh,
    loadDiffForFile,
    requestFullDiff,

    // Stash (kept as bundle to preserve `stash.foo` usage in ReviewPane)
    stash,

    // Workflow
    selectedAction,
    setSelectedAction,
    actionInProgress,
    setActionInProgress,
    pushInProgress,
    mergeInProgress,
    prInProgress,
    prDialog,
    setPrDialog,
    mergeDialog,
    setMergeDialog,
    hasRebaseConflict,
    setHasRebaseConflict,
    commitInProgress,
    commitEntry,
    commitProgressId,
    handleCommitAction,
    handlePushOnly,
    openMergeDialog,
    handleMergeWithTarget,
    handleCreatePROnly,

    // Actions
    pullInProgress,
    fetchInProgress,
    stashInProgress,
    resetInProgress,
    patchStagingInProgress,
    pullStrategyDialog,
    setPullStrategyDialog,
    fileSelectionState,
    setFileSelectionState,
    selectAllSignal,
    setSelectAllSignal,
    deselectAllSignal,
    setDeselectAllSignal,
    handleRevertFile,
    executeRevert,
    handleDiscardAll,
    handleDiscardFolder,
    executeDiscardAll,
    handleIgnoreFiles,
    executeIgnoreFiles,
    handleIgnore,
    executeResetSoft,
    handleStageFile,
    handleUnstageFile,
    handleStageSelected,
    handleUnstageAll,
    handleStagePatch,
    handleSelectionStateChange,
    handleResolveConflict,
    handleAskAgentResolve,
    handleOpenInEditorConflict,
    handlePull,
    handlePullStrategyChosen,
    handleFetchOrigin,
    handleStash,
    handleStashSelected,
    handleCopyPath,
    handleOpenDirectory,
  };
}
