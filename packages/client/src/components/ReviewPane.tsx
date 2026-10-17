import { useTranslation } from 'react-i18next';

import { Tabs } from '@/components/ui/tabs';
import type { ReviewSubTab } from '@/stores/ui-store';

import { ExpandedDiffPresenter } from './review-pane/ExpandedDiffPresenter';
import { buildFileSearch, buildPrSummary } from './review-pane/review-pane-props';
import { ReviewChangesTab } from './review-pane/ReviewChangesTab';
import { ReviewDialogs } from './review-pane/ReviewDialogs';
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
  const {
    summaries,
    selectedFile,
    setSelectedFile,
    expandedFile,
    setExpandedFile,
    fileSearch,
    setFileSearch,
    fileSearchCaseSensitive,
    setFileSearchCaseSensitive,
    checkedFiles,
    checkedCount,
    totalCount,
    toggleFile,
    toggleAll,
    canCommit,
    isOnDifferentBranch,
    commitTitle,
    commitBody,
    setCommitTitle,
    setCommitBody,
    generatingMsg,
    handleGenerateCommitMsg,
    remoteUrl,
    publishDialogOpen,
    setPublishDialogOpen,
    handlePublishSuccess,
    filteredDiffs,
    collapsedFolders,
    toggleFolder,
    handleCollapseAllFolders,
    handleExpandAllFolders,
    hasFolders,
    allFoldersCollapsed,
    expandedSubmodules,
    toggleSubmodule,
    treeRows,
    diffCache,
    loadingDiff,
    loading,
    loadError,
    loadErrorMessage,
    truncatedInfo,
    refresh,
    loadDiffForFile,
    requestFullDiff,
    stash,
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
    commitInProgress,
    commitEntry,
    commitProgressId,
    handleCommitAction,
    handlePushOnly,
    openMergeDialog,
    handleMergeWithTarget,
    handleCreatePROnly,
    pullInProgress,
    fetchInProgress,
    stashInProgress,
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
    handleStashSelected,
    handleCopyPath,
    handleOpenDirectory,
  } = review;

  return (
    <div className="flex h-full flex-col">
      <ExpandedDiffPresenter
        expandedFile={expandedFile}
        expandedSummary={expanded.summary}
        expandedDiffContent={expanded.diffContent}
        ExpandedIcon={expanded.Icon}
        onClose={expanded.onClose}
        onFileSelect={expanded.onFileSelect}
        fileSearch={fileSearch}
        setFileSearch={setFileSearch}
        fileSearchCaseSensitive={fileSearchCaseSensitive}
        setFileSearchCaseSensitive={setFileSearchCaseSensitive}
        filteredDiffs={filteredDiffs}
        summaries={summaries}
        checkedFiles={checkedFiles}
        toggleFile={toggleFile}
        onRevertFile={handleRevertFile}
        onIgnore={handleIgnore}
        basePath={basePath}
        loadingDiff={loadingDiff}
        diffCache={diffCache}
        prThreads={prThreads}
        requestFullDiff={requestFullDiff}
        handleResolveConflict={handleResolveConflict}
        handleStagePatch={handleStagePatch}
        patchStagingInProgress={patchStagingInProgress}
        handleSelectionStateChange={handleSelectionStateChange}
        selectAllSignal={selectAllSignal}
        deselectAllSignal={deselectAllSignal}
      />
      {/* Normal ReviewPane content */}
      <Tabs
        value={reviewSubTab}
        onValueChange={(v) => setReviewSubTab(v as ReviewSubTab)}
        className="flex h-full flex-col text-xs"
        style={{ contain: 'strict' }}
      >
        {/* Header with tabs */}
        <ReviewPaneTabsHeader onClose={() => setReviewPaneOpen(false)} />

        <ReviewChangesTab
          truncatedInfo={truncatedInfo}
          summaries={summaries}
          prSummary={buildPrSummary(
            gitStatus,
            projectId,
            reviewSubTab === 'changes' && reviewPaneOpen,
          )}
          search={buildFileSearch({
            fileSearch,
            setFileSearch,
            caseSensitive: fileSearchCaseSensitive,
            setCaseSensitive: setFileSearchCaseSensitive,
            matchCount: filteredDiffs.length,
            totalCount: summaries.length,
            placeholder: t('review.searchFiles', 'Filter files…'),
          })}
          toolbar={{
            refresh: refreshAll,
            loading,
            handlePull,
            handleFetchOrigin,
            pullInProgress,
            fetchInProgress,
            handlePushOnly,
            pushInProgress,
            remoteUrl,
            setPublishDialogOpen,
            unpushedCommitCount,
            threadBranch,
            baseBranch,
            isOnDifferentBranch,
            openMergeDialog,
            mergeInProgress,
            setPrDialog,
            summaries,
            checkedFiles,
            handleStageSelected,
            handleUnstageAll,
            handleStashSelected,
            handleDiscardAll,
            handleIgnoreFiles,
            actionInProgress,
            stashInProgress,
            gitStatus,
            isAgentRunning,
            readOnly: viewerReadOnly,
          }}
          filesPanel={{
            summaries,
            filteredDiffs,
            checkedCount,
            totalCount,
            toggleAll,
            hasFolders,
            allFoldersCollapsed,
            collapsedFolders,
            handleCollapseAllFolders,
            handleExpandAllFolders,
            loading,
            loadError,
            loadErrorMessage,
            refresh,
            fileSearch,
            treeRows,
            selectedFile,
            setSelectedFile,
            expandedFile,
            setExpandedFile,
            loadDiffForFile,
            checkedFiles,
            toggleFile,
            toggleFolder,
            toggleSubmodule,
            expandedSubmodules,
            fileSelectionState,
            setFileSelectionState,
            setSelectAllSignal,
            setDeselectAllSignal,
            handleStageFile,
            handleUnstageFile,
            handleRevertFile,
            handleDiscardFolder,
            handleIgnore,
            handleCopyPath,
            handleOpenDirectory,
            basePath,
            readOnly: viewerReadOnly,
          }}
          commitDraft={{
            commitEntry,
            commitProgressId,
            setActionInProgress,
            summaries,
            commitInProgress,
            commitTitle,
            commitBody,
            setCommitTitle,
            setCommitBody,
            generatingMsg,
            handleGenerateCommitMsg,
            selectedAction,
            setSelectedAction,
            actionInProgress,
            isOnDifferentBranch,
            gitStatus,
            canCommit,
            handleCommitAction,
            isAgentRunning,
            effectiveThreadId,
            hasRebaseConflict,
            baseBranch,
            isWorktree,
            handleOpenInEditorConflict,
            handleAskAgentResolve,
            readOnly: viewerReadOnly,
          }}
        />

        <ReviewSecondaryTabs
          reviewSubTab={reviewSubTab}
          reviewPaneOpen={reviewPaneOpen}
          stashTab={{
            stash,
            currentBranch,
            isAgentRunning,
            onRequestDrop: (stashIndex) => setConfirmDialog({ type: 'drop-stash', stashIndex }),
          }}
          projectId={projectId}
          prNumber={prNumber}
          prUrl={prUrl}
        />
      </Tabs>

      <ReviewDialogs
        confirmDialog={confirmDialog}
        setConfirmDialog={setConfirmDialog}
        executeRevert={executeRevert}
        executeDiscardAll={executeDiscardAll}
        executeIgnoreFiles={executeIgnoreFiles}
        executeResetSoft={executeResetSoft}
        executeStashDrop={stash.executeStashDrop}
        pullStrategyDialog={pullStrategyDialog}
        setPullStrategyDialog={setPullStrategyDialog}
        handlePullStrategyChosen={handlePullStrategyChosen}
        prDialog={prDialog}
        setPrDialog={setPrDialog}
        threadBranch={threadBranch}
        baseBranch={baseBranch}
        prInProgress={prInProgress}
        handleCreatePROnly={handleCreatePROnly}
        mergeDialog={mergeDialog}
        setMergeDialog={setMergeDialog}
        currentBranch={currentBranch}
        mergeInProgress={mergeInProgress}
        handleMergeWithTarget={handleMergeWithTarget}
        publishProjectId={remoteCheckProjectId ?? ''}
        publishProjectPath={basePath}
        publishDialogOpen={publishDialogOpen}
        setPublishDialogOpen={setPublishDialogOpen}
        handlePublishSuccess={handlePublishSuccess}
      />
    </div>
  );
}
