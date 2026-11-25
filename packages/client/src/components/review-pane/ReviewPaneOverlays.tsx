import { ExpandedDiffPresenter } from './ExpandedDiffPresenter';
import { ReviewDialogs } from './ReviewDialogs';
import type { useReviewPaneModel } from './use-review-pane-model';

/**
 * The review pane's two overlays (the expanded diff and the action dialogs),
 * wired to the review-pane model. Both Radix-portal to document.body.
 */

type ReviewPaneModel = ReturnType<typeof useReviewPaneModel>;

/** The full-screen expanded diff of the selected file. */
export function ReviewExpandedDiff({
  review,
  expanded,
  basePath,
  prThreads,
}: Pick<ReviewPaneModel, 'review' | 'expanded' | 'basePath' | 'prThreads'>) {
  return (
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
  );
}

/** Confirm, pull-strategy, PR, merge and publish dialogs. */
export function ReviewPaneDialogs({
  review,
  confirmDialog,
  setConfirmDialog,
  threadBranch,
  baseBranch,
  currentBranch,
  remoteCheckProjectId,
  basePath,
}: Pick<
  ReviewPaneModel,
  | 'review'
  | 'confirmDialog'
  | 'setConfirmDialog'
  | 'threadBranch'
  | 'baseBranch'
  | 'currentBranch'
  | 'remoteCheckProjectId'
  | 'basePath'
>) {
  return (
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
  );
}
