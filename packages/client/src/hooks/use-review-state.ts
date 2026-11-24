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
import type { ProjectGitStatus } from '@/data/git-status/keys';
import { useCommitDraft } from '@/hooks/use-commit-draft';
import { useCommitWorkflow } from '@/hooks/use-commit-workflow';
import { useDiffData } from '@/hooks/use-diff-data';
import { useFileTreeState } from '@/hooks/use-file-tree-state';
import { useGenerateCommitMsg } from '@/hooks/use-generate-commit-msg';
import { usePublishState } from '@/hooks/use-publish-state';
import { useReviewActions } from '@/hooks/use-review-actions';
import { useStableCallback } from '@/hooks/use-stable-callback';
import { useStashState } from '@/hooks/use-stash-state';
import { metric } from '@/lib/telemetry';
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

type DiffData = ReturnType<typeof useDiffData>;

/**
 * The Changes tab stays mounted while the user visits History/Stash/PRs, so
 * returning to it does not naturally remount or reload its diff summary. Treat
 * tab activation as a visibility event and refresh the working-tree snapshot.
 */
function useRefreshOnChangesTab(
  reviewSubTab: ReviewSubTab,
  hasGitContext: boolean,
  reviewPaneOpen: boolean,
  { refresh, needsRefreshRef }: Pick<DiffData, 'refresh' | 'needsRefreshRef'>,
): void {
  const prevReviewSubTabRef = useRef<ReviewSubTab | undefined>(undefined);
  useEffect(() => {
    const previousTab = prevReviewSubTabRef.current;
    prevReviewSubTabRef.current = reviewSubTab;

    if (previousTab === undefined || previousTab === 'changes' || reviewSubTab !== 'changes') {
      return;
    }

    if (!hasGitContext) return;

    if (reviewPaneOpen) {
      void refresh();
    } else {
      needsRefreshRef.current = true;
    }
  }, [reviewSubTab, hasGitContext, reviewPaneOpen, refresh, needsRefreshRef]);
}

interface AutoCloseArgs {
  justCompletedWorkflowRef: React.MutableRefObject<boolean>;
  loading: boolean;
  summaryCount: number;
  stashCount: number;
  unpushedCommitCount: number;
  hasRebaseConflict: boolean;
  setReviewPaneOpen: (open: boolean) => void;
}

/** Auto-close the pane when the branch goes fully clean after a workflow. */
function useAutoCloseWhenClean({
  justCompletedWorkflowRef,
  loading,
  summaryCount,
  stashCount,
  unpushedCommitCount,
  hasRebaseConflict,
  setReviewPaneOpen,
}: AutoCloseArgs): void {
  useEffect(() => {
    if (
      justCompletedWorkflowRef.current &&
      !loading &&
      summaryCount === 0 &&
      stashCount === 0 &&
      unpushedCommitCount === 0 &&
      !hasRebaseConflict
    ) {
      justCompletedWorkflowRef.current = false;
      setReviewPaneOpen(false);
    }
  }, [
    loading,
    summaryCount,
    stashCount,
    unpushedCommitCount,
    hasRebaseConflict,
    setReviewPaneOpen,
    justCompletedWorkflowRef,
  ]);
}

interface ResetOnContextChangeArgs {
  gitContextKey: string | null;
  currentBranch: string | undefined;
  reviewPaneOpen: boolean;
  effectiveThreadId: string | undefined;
  projectModeId: string | null;
  diffData: DiffData;
  abortGenerate: () => void;
  setSummaries: Dispatch<SetStateAction<FileDiffSummary[]>>;
  setSelectedFile: Dispatch<SetStateAction<string | null>>;
  setCheckedFiles: Dispatch<SetStateAction<Set<string>>>;
  setFileSearch: Dispatch<SetStateAction<string>>;
  setHasRebaseConflict: (value: boolean) => void;
  setSelectedAction: (action: 'commit') => void;
}

/** Reset on context change (thread/project switch or branch checkout). */
function useResetOnContextChange({
  gitContextKey,
  currentBranch,
  reviewPaneOpen,
  effectiveThreadId,
  projectModeId,
  diffData,
  abortGenerate,
  setSummaries,
  setSelectedFile,
  setCheckedFiles,
  setFileSearch,
  setHasRebaseConflict,
  setSelectedAction,
}: ResetOnContextChangeArgs): void {
  const { abortRef, setDiffCache, setLoadError, setLoadErrorMessage, refresh, needsRefreshRef } =
    diffData;
  // Track the last-seen context + branch so the reset effect can tell a real
  // branch SWITCH (checkout) apart from the initial async hydration of the
  // branch name. `undefined` sentinel means "not seen yet".
  const prevGitContextKeyRef = useRef<string | null | undefined>(undefined);
  const prevCurrentBranchRef = useRef<string | undefined>(undefined);

  const resetOnContextChange = useStableCallback(() => {
    const contextChanged = gitContextKey !== prevGitContextKeyRef.current;
    const branchChanged = currentBranch !== prevCurrentBranchRef.current;
    // `currentBranch` comes from the project's branch listing, which hydrates asynchronously
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

    if (isInitialBranchHydration) {
      metric('review.reset_gate', 1, { attributes: { decision: 'skip-branch-hydration' } });
      return;
    }

    // Permanent diagnostic: this effect is the primary refresh trigger on a
    // thread/project switch. If the Changes tab shows a stale "No changes", the
    // most common cause is this effect either not running (gitContextKey didn't
    // change because the right pane follows a different id) or deferring the
    // refresh because reviewPaneOpen is stale-false. See packages/client/CLAUDE.md.
    metric('review.reset_gate', 1, {
      attributes: {
        decision: reviewPaneOpen ? 'refresh' : 'defer',
        contextChanged: String(contextChanged),
        threadId: effectiveThreadId ?? projectModeId ?? 'unknown',
      },
    });

    abortRef.current?.abort();
    abortGenerate();

    setSummaries([]);
    setDiffCache(new Map());
    setSelectedFile(null);
    setCheckedFiles(new Set());
    setFileSearch('');
    setHasRebaseConflict(false);
    setLoadError(false);
    setLoadErrorMessage(null);
    setSelectedAction('commit');

    if (reviewPaneOpen) {
      refresh();
    } else {
      needsRefreshRef.current = true;
    }
  });
  useEffect(() => {
    resetOnContextChange();
  }, [gitContextKey, currentBranch, resetOnContextChange]);
}

/** The checked files among the visible ones, and toggling them. */
function useFileChecks(
  checkedFiles: Set<string>,
  setCheckedFiles: Dispatch<SetStateAction<Set<string>>>,
  visiblePaths: Set<string>,
  visibleFileCount: number,
) {
  const checkedCount = [...checkedFiles].filter((p) => visiblePaths.has(p)).length;
  const totalCount = visibleFileCount;

  const toggleFile = useCallback(
    (path: string) => {
      setCheckedFiles((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
    },
    [setCheckedFiles],
  );

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
  }, [visiblePaths, checkedFiles, setCheckedFiles]);

  return { checkedCount, totalCount, toggleFile, toggleAll };
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

  const diffData = useDiffData({
    hasGitContext,
    effectiveThreadId,
    projectModeId,
    selectedFile,
    expandedFile,
    reviewPaneOpen,
    currentBranch,
    summaries,
    setSummaries,
    submoduleExpansions: tree.submoduleExpansions,
    setSelectedFile,
    setCheckedFiles,
    dirtyFileCount: gitStatus?.dirtyFileCount,
    linesAdded: gitStatus?.linesAdded,
    linesDeleted: gitStatus?.linesDeleted,
  });
  const { abortRef, refresh } = diffData;

  useRefreshOnChangesTab(reviewSubTab, hasGitContext, reviewPaneOpen, diffData);

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

  const { justCompletedWorkflowRef, ...workflow } = useCommitWorkflow({
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
  const { selectedAction, setSelectedAction, actionInProgress, hasRebaseConflict } = workflow;
  const { setHasRebaseConflict } = workflow;

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
    loadDiffForFile: diffData.loadDiffForFile,
    setDiffCache: diffData.setDiffCache,
    setHasRebaseConflict,
    setConfirmDialog,
    refreshStashList: stash.refreshStashList,
  });

  useAutoCloseWhenClean({
    justCompletedWorkflowRef,
    loading: diffData.loading,
    summaryCount: summaries.length,
    stashCount: stash.stashEntries.length,
    unpushedCommitCount,
    hasRebaseConflict,
    setReviewPaneOpen,
  });

  useResetOnContextChange({
    gitContextKey,
    currentBranch,
    reviewPaneOpen,
    effectiveThreadId,
    projectModeId,
    diffData,
    abortGenerate,
    setSummaries,
    setSelectedFile,
    setCheckedFiles,
    setFileSearch,
    setHasRebaseConflict,
    setSelectedAction,
  });

  // ── Reset selectedAction if "commit-pr" picked but PR already exists ──
  useEffect(() => {
    if (selectedAction === 'commit-pr' && gitStatus?.prNumber) {
      setSelectedAction('commit');
    }
  }, [selectedAction, gitStatus?.prNumber, setSelectedAction]);

  // ── Derived selection counters ──
  const checks = useFileChecks(
    checkedFiles,
    setCheckedFiles,
    tree.visiblePaths,
    tree.visibleFiles.length,
  );

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
    ...checks,
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

    // File tree, diff data, workflow and actions: every field each hook returns
    // (the workflow's `justCompletedWorkflowRef` stays internal).
    ...tree,
    ...diffData,

    // Stash (kept as bundle to preserve `stash.foo` usage in ReviewPane)
    stash,

    ...workflow,
    ...actions,
  };
}
