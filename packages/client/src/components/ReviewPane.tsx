import { useTranslation } from 'react-i18next';

import { Tabs } from '@/components/ui/tabs';
import type { ReviewSubTab } from '@/stores/ui-store';

import { buildFileSearch, buildPrSummary } from './review-pane/review-pane-props';
import { ReviewChangesTab } from './review-pane/ReviewChangesTab';
import { ReviewExpandedDiff, ReviewPaneDialogs } from './review-pane/ReviewPaneOverlays';
import { ReviewPaneTabsHeader, ReviewSecondaryTabs } from './review-pane/ReviewPaneTabs';
import { useReviewPaneModel } from './review-pane/use-review-pane-model';

export function ReviewPane() {
  const { t } = useTranslation();
  const {
    effectiveThreadId,
    basePath,
    viewerReadOnly,
    isWorktree,
    baseBranch,
    threadBranch,
    currentBranch,
    isAgentRunning,
    gitStatus,
    projectId,
    prNumber,
    prUrl,
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
    setReviewSubTab,
    expanded,
  } = useReviewPaneModel();

  return (
    <div className="flex h-full flex-col">
      <ReviewExpandedDiff
        review={review}
        expanded={expanded}
        basePath={basePath}
        prThreads={prThreads}
      />
      {/* Normal ReviewPane content */}
      <Tabs
        value={reviewSubTab}
        // SAFETY: the triggers come from TABS in ReviewPaneTabs, whose values are typed ReviewSubTab.
        onValueChange={(v) => setReviewSubTab(v as ReviewSubTab)}
        asChild
      >
        <div className="flex h-full flex-col text-xs [contain:strict]">
          {/* Header with tabs */}
          <ReviewPaneTabsHeader onClose={() => setReviewPaneOpen(false)} />

          <ReviewChangesTab
            truncatedInfo={review.truncatedInfo}
            summaries={review.summaries}
            prSummary={buildPrSummary(
              gitStatus,
              projectId,
              reviewSubTab === 'changes' && reviewPaneOpen,
            )}
            search={buildFileSearch({
              fileSearch: review.fileSearch,
              setFileSearch: review.setFileSearch,
              caseSensitive: review.fileSearchCaseSensitive,
              setCaseSensitive: review.setFileSearchCaseSensitive,
              matchCount: review.filteredDiffs.length,
              totalCount: review.summaries.length,
              placeholder: t('review.searchFiles', 'Filter files…'),
            })}
            toolbar={{
              refresh: refreshAll,
              loading: review.loading,
              handlePull: review.handlePull,
              handleFetchOrigin: review.handleFetchOrigin,
              pullInProgress: review.pullInProgress,
              fetchInProgress: review.fetchInProgress,
              handlePushOnly: review.handlePushOnly,
              pushInProgress: review.pushInProgress,
              remoteUrl: review.remoteUrl,
              setPublishDialogOpen: review.setPublishDialogOpen,
              unpushedCommitCount,
              threadBranch,
              baseBranch,
              isOnDifferentBranch: review.isOnDifferentBranch,
              openMergeDialog: review.openMergeDialog,
              mergeInProgress: review.mergeInProgress,
              setPrDialog: review.setPrDialog,
              summaries: review.summaries,
              checkedFiles: review.checkedFiles,
              handleStageSelected: review.handleStageSelected,
              handleUnstageAll: review.handleUnstageAll,
              handleStashSelected: review.handleStashSelected,
              handleDiscardAll: review.handleDiscardAll,
              handleIgnoreFiles: review.handleIgnoreFiles,
              actionInProgress: review.actionInProgress,
              stashInProgress: review.stashInProgress,
              gitStatus,
              isAgentRunning,
              readOnly: viewerReadOnly,
            }}
            filesPanel={{
              summaries: review.summaries,
              filteredDiffs: review.filteredDiffs,
              checkedCount: review.checkedCount,
              totalCount: review.totalCount,
              toggleAll: review.toggleAll,
              hasFolders: review.hasFolders,
              allFoldersCollapsed: review.allFoldersCollapsed,
              collapsedFolders: review.collapsedFolders,
              handleCollapseAllFolders: review.handleCollapseAllFolders,
              handleExpandAllFolders: review.handleExpandAllFolders,
              loading: review.loading,
              loadError: review.loadError,
              loadErrorMessage: review.loadErrorMessage,
              refresh: review.refresh,
              fileSearch: review.fileSearch,
              treeRows: review.treeRows,
              selectedFile: review.selectedFile,
              setSelectedFile: review.setSelectedFile,
              expandedFile: review.expandedFile,
              setExpandedFile: review.setExpandedFile,
              loadDiffForFile: review.loadDiffForFile,
              checkedFiles: review.checkedFiles,
              toggleFile: review.toggleFile,
              toggleFolder: review.toggleFolder,
              toggleSubmodule: review.toggleSubmodule,
              expandedSubmodules: review.expandedSubmodules,
              fileSelectionState: review.fileSelectionState,
              setFileSelectionState: review.setFileSelectionState,
              setSelectAllSignal: review.setSelectAllSignal,
              setDeselectAllSignal: review.setDeselectAllSignal,
              handleStageFile: review.handleStageFile,
              handleUnstageFile: review.handleUnstageFile,
              handleRevertFile: review.handleRevertFile,
              handleDiscardFolder: review.handleDiscardFolder,
              handleIgnore: review.handleIgnore,
              handleCopyPath: review.handleCopyPath,
              handleOpenDirectory: review.handleOpenDirectory,
              basePath,
              readOnly: viewerReadOnly,
            }}
            commitDraft={{
              commitEntry: review.commitEntry,
              commitProgressId: review.commitProgressId,
              setActionInProgress: review.setActionInProgress,
              summaries: review.summaries,
              commitInProgress: review.commitInProgress,
              commitTitle: review.commitTitle,
              commitBody: review.commitBody,
              setCommitTitle: review.setCommitTitle,
              setCommitBody: review.setCommitBody,
              generatingMsg: review.generatingMsg,
              handleGenerateCommitMsg: review.handleGenerateCommitMsg,
              selectedAction: review.selectedAction,
              setSelectedAction: review.setSelectedAction,
              actionInProgress: review.actionInProgress,
              isOnDifferentBranch: review.isOnDifferentBranch,
              gitStatus,
              canCommit: review.canCommit,
              handleCommitAction: review.handleCommitAction,
              isAgentRunning,
              effectiveThreadId,
              hasRebaseConflict: review.hasRebaseConflict,
              baseBranch,
              isWorktree,
              handleOpenInEditorConflict: review.handleOpenInEditorConflict,
              handleAskAgentResolve: review.handleAskAgentResolve,
              readOnly: viewerReadOnly,
            }}
          />

          <ReviewSecondaryTabs
            activePath={basePath}
            readOnly={viewerReadOnly}
            reviewSubTab={reviewSubTab}
            reviewPaneOpen={reviewPaneOpen}
            stashTab={{
              stash: review.stash,
              currentBranch,
              isAgentRunning,
              onRequestDrop: (stashIndex) => setConfirmDialog({ type: 'drop-stash', stashIndex }),
            }}
            projectId={projectId}
            prNumber={prNumber}
            prUrl={prUrl}
          />
        </div>
      </Tabs>

      <ReviewPaneDialogs
        review={review}
        confirmDialog={confirmDialog}
        setConfirmDialog={setConfirmDialog}
        threadBranch={threadBranch}
        baseBranch={baseBranch}
        currentBranch={currentBranch}
        remoteCheckProjectId={remoteCheckProjectId}
        basePath={basePath}
      />
    </div>
  );
}
