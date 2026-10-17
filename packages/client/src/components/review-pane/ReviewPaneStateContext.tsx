import { type ReactNode, createContext, useContext, useMemo } from 'react';

import type { useReviewState } from '@/hooks/use-review-state';
import type { useGitStatusForThread, ProjectGitStatus } from '@/stores/git-status-store';
import type { usePRDetail } from '@/stores/pr-detail-store';
import type { ReviewSubTab } from '@/stores/ui-store';

import { ExpandedDiffPresenter } from './ExpandedDiffPresenter';
import { ReviewDialogs, type ConfirmDialogState } from './ReviewDialogs';
import { useReviewPaneModel } from './use-review-pane-model';

/**
 * Context that exposes all the state ReviewPane used to own. Lifted out of the
 * component so the 4 sub-tabs (Changes / History / Stash / PRs) can live in
 * separate dockview panels yet share a single instance of state.
 */
type ReviewPaneContextValue = ReturnType<typeof useReviewState> & {
  // Inputs we threaded into useReviewState — kept around because some children
  // need them directly (StashTab needs `isAgentRunning`, ReviewChangesTab needs
  // gitStatus / baseBranch / etc.).
  effectiveThreadId: string | undefined;
  threadProjectId: string | undefined;
  selectedProjectId: string | null;
  basePath: string;
  isWorktree: boolean;
  baseBranch: string | undefined;
  threadBranch: string | undefined;
  currentBranch: string | undefined;
  isAgentRunning: boolean;
  gitStatus: NonNullable<ReturnType<typeof useGitStatusForThread>> | ProjectGitStatus | undefined;
  prThreads: ReturnType<typeof usePRDetail>['threads'];
  unpushedCommitCount: number;
  remoteCheckProjectId: string | null;
  // UI store-derived
  reviewPaneOpen: boolean;
  reviewSubTab: ReviewSubTab;
  setReviewPaneOpen: (open: boolean) => void;
  setReviewSubTab: (tab: ReviewSubTab) => void;
  refreshAll: () => Promise<void>;
  // Local UI state
  confirmDialog: ConfirmDialogState | null;
  setConfirmDialog: React.Dispatch<React.SetStateAction<ConfirmDialogState | null>>;
  /**
   * True when the current viewer is a NON-OWNER sharee (thread-sharing-steer):
   * the review pane is READ-ONLY for them. A `view` sharee can't even open the
   * pane (gated upstream in ProjectHeader), so in practice this flags a `steer`
   * sharee. Every git WRITE is owner-only server-side; this just hides the write
   * affordances so a steer sharee sees a clean read-only diff view.
   */
  viewerReadOnly: boolean;
};

const ReviewPaneContext = createContext<ReviewPaneContextValue | null>(null);

export function useReviewPaneContext(): ReviewPaneContextValue {
  const ctx = useContext(ReviewPaneContext);
  if (!ctx) {
    throw new Error(
      'useReviewPaneContext must be used inside <ReviewPaneStateProvider>. ' +
        'Wrap the right-pane subtree with the provider so all 4 tabs share state.',
    );
  }
  return ctx;
}

/**
 * Lifts the whole "review pane" state out of ReviewPane.tsx so multiple dockview
 * panels (Changes / History / Stash / PRs) can render against the same instance.
 * Also renders the two global overlays (DiffViewerModal, ReviewDialogs) which
 * Radix-portal to document.body and therefore can live anywhere in the tree.
 */
export function ReviewPaneStateProvider({ children }: { children: ReactNode }) {
  const {
    effectiveThreadId,
    threadProjectId,
    selectedProjectId,
    basePath,
    isWorktree,
    baseBranch,
    threadBranch,
    currentBranch,
    isAgentRunning,
    gitStatus,
    prThreads,
    unpushedCommitCount,
    remoteCheckProjectId,
    reviewPaneOpen,
    reviewSubTab,
    setReviewPaneOpen,
    confirmDialog,
    setConfirmDialog,
    review,
    refreshAll,
    // Sync the active sub-tab with the URL query param. Kept in the shared
    // model so that dockview tab clicks (which call this) and URL navigation
    // share one source of truth.
    setReviewSubTab,
    // A non-owner viewer (necessarily a `steer` sharee — `view` sharees can't
    // open the pane) gets a read-only review pane. In project-mode (no thread
    // owner) or while auth loads, this is false, so the owner never loses
    // write controls.
    viewerReadOnly,
    expanded,
  } = useReviewPaneModel();

  const value = useMemo<ReviewPaneContextValue>(
    () => ({
      ...review,
      effectiveThreadId,
      threadProjectId,
      selectedProjectId,
      basePath,
      isWorktree,
      baseBranch,
      threadBranch,
      currentBranch,
      isAgentRunning,
      gitStatus,
      prThreads,
      unpushedCommitCount,
      remoteCheckProjectId,
      reviewPaneOpen,
      reviewSubTab,
      setReviewPaneOpen,
      setReviewSubTab,
      refreshAll,
      confirmDialog,
      setConfirmDialog,
      viewerReadOnly,
    }),
    [
      review,
      effectiveThreadId,
      threadProjectId,
      selectedProjectId,
      basePath,
      isWorktree,
      baseBranch,
      threadBranch,
      currentBranch,
      isAgentRunning,
      gitStatus,
      prThreads,
      unpushedCommitCount,
      remoteCheckProjectId,
      reviewPaneOpen,
      reviewSubTab,
      setReviewPaneOpen,
      setReviewSubTab,
      refreshAll,
      confirmDialog,
      setConfirmDialog,
      viewerReadOnly,
    ],
  );

  return (
    <ReviewPaneContext.Provider value={value}>
      {children}
      {/* Both overlays Radix-portal to document.body, so positioning them here
          is fine regardless of where the tabs render. */}
      <ExpandedDiffPresenter
        expandedFile={review.expandedFile}
        expandedSummary={expanded.summary}
        expandedDiffContent={expanded.diffContent}
        ExpandedIcon={expanded.Icon}
        onClose={expanded.onClose}
        onFileSelect={expanded.onFileSelect}
        fileSearch={review.fileSearch}
        setFileSearch={review.setFileSearch}
        fileSearchCaseSensitive={review.fileSearchCaseSensitive}
        setFileSearchCaseSensitive={review.setFileSearchCaseSensitive}
        filteredDiffs={review.filteredDiffs}
        summaries={review.summaries}
        checkedFiles={review.checkedFiles}
        toggleFile={review.toggleFile}
        onRevertFile={review.handleRevertFile}
        onIgnore={review.handleIgnore}
        basePath={basePath}
        loadingDiff={review.loadingDiff}
        diffCache={review.diffCache}
        prThreads={prThreads}
        requestFullDiff={review.requestFullDiff}
        handleResolveConflict={review.handleResolveConflict}
        handleStagePatch={review.handleStagePatch}
        patchStagingInProgress={review.patchStagingInProgress}
        handleSelectionStateChange={review.handleSelectionStateChange}
        selectAllSignal={review.selectAllSignal}
        deselectAllSignal={review.deselectAllSignal}
      />
      <ReviewDialogs
        confirmDialog={confirmDialog}
        setConfirmDialog={setConfirmDialog}
        executeRevert={review.executeRevert}
        executeDiscardAll={review.executeDiscardAll}
        executeIgnoreFiles={review.executeIgnoreFiles}
        executeResetSoft={review.executeResetSoft}
        executeStashDrop={review.stash.executeStashDrop}
        pullStrategyDialog={review.pullStrategyDialog}
        setPullStrategyDialog={review.setPullStrategyDialog}
        handlePullStrategyChosen={review.handlePullStrategyChosen}
        prDialog={review.prDialog}
        setPrDialog={review.setPrDialog}
        threadBranch={threadBranch}
        baseBranch={baseBranch}
        prInProgress={review.prInProgress}
        handleCreatePROnly={review.handleCreatePROnly}
        mergeDialog={review.mergeDialog}
        setMergeDialog={review.setMergeDialog}
        currentBranch={currentBranch}
        mergeInProgress={review.mergeInProgress}
        handleMergeWithTarget={review.handleMergeWithTarget}
        publishProjectId={remoteCheckProjectId ?? ''}
        publishProjectPath={basePath}
        publishDialogOpen={review.publishDialogOpen}
        setPublishDialogOpen={review.setPublishDialogOpen}
        handlePublishSuccess={review.handlePublishSuccess}
      />
    </ReviewPaneContext.Provider>
  );
}
