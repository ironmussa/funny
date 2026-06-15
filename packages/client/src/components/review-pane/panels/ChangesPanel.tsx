import { useTranslation } from 'react-i18next';

import { CommitGraphTab } from '@/components/CommitGraphTab';
import { CommitHistoryTab } from '@/components/CommitHistoryTab';
import { IssuesTab } from '@/components/IssuesTab';
import { PullRequestsTab } from '@/components/PullRequestsTab';

import { ReviewChangesTabContent } from '../ReviewChangesTab';
import { useReviewPaneContext } from '../ReviewPaneStateContext';
import { StashTab } from '../StashTab';

/** Dockview panel: Changes — the bulk of ReviewPane (file tree + commit draft). */
export function ChangesPanel() {
  const { t } = useTranslation();
  const ctx = useReviewPaneContext();

  return (
    <div className="flex h-full w-full flex-col text-xs">
      <ReviewChangesTabContent
        truncatedInfo={ctx.truncatedInfo}
        summaries={ctx.summaries}
        prSummary={
          ctx.gitStatus?.prNumber
            ? {
                projectId: ctx.threadProjectId ?? ctx.selectedProjectId ?? '',
                prNumber: ctx.gitStatus.prNumber,
                prUrl: ctx.gitStatus.prUrl ?? '',
                prState: ctx.gitStatus.prState ?? 'OPEN',
                visible: ctx.reviewSubTab === 'changes' && ctx.reviewPaneOpen,
              }
            : null
        }
        search={{
          query: ctx.fileSearch,
          onQueryChange: ctx.setFileSearch,
          placeholder: t('review.searchFiles', 'Filter files…'),
          totalMatches: ctx.filteredDiffs.length,
          resultLabel: ctx.fileSearch ? `${ctx.filteredDiffs.length}/${ctx.summaries.length}` : '',
          caseSensitive: ctx.fileSearchCaseSensitive,
          onCaseSensitiveChange: ctx.setFileSearchCaseSensitive,
          onClose: ctx.fileSearch ? () => ctx.setFileSearch('') : undefined,
          autoFocus: false,
          testIdPrefix: 'review-file-filter',
        }}
        toolbar={{
          refresh: ctx.refresh,
          loading: ctx.loading,
          handlePull: ctx.handlePull,
          handleFetchOrigin: ctx.handleFetchOrigin,
          pullInProgress: ctx.pullInProgress,
          fetchInProgress: ctx.fetchInProgress,
          handlePushOnly: ctx.handlePushOnly,
          pushInProgress: ctx.pushInProgress,
          remoteUrl: ctx.remoteUrl,
          setPublishDialogOpen: ctx.setPublishDialogOpen,
          unpushedCommitCount: ctx.unpushedCommitCount,
          threadBranch: ctx.threadBranch,
          baseBranch: ctx.baseBranch,
          isOnDifferentBranch: ctx.isOnDifferentBranch,
          openMergeDialog: ctx.openMergeDialog,
          mergeInProgress: ctx.mergeInProgress,
          setPrDialog: ctx.setPrDialog,
          summaries: ctx.summaries,
          checkedFiles: ctx.checkedFiles,
          handleStageSelected: ctx.handleStageSelected,
          handleUnstageAll: ctx.handleUnstageAll,
          handleStashSelected: ctx.handleStashSelected,
          handleDiscardAll: ctx.handleDiscardAll,
          handleIgnoreFiles: ctx.handleIgnoreFiles,
          actionInProgress: ctx.actionInProgress,
          stashInProgress: ctx.stashInProgress,
          gitStatus: ctx.gitStatus,
          isAgentRunning: ctx.isAgentRunning,
          readOnly: ctx.viewerReadOnly,
        }}
        filesPanel={{
          summaries: ctx.summaries,
          filteredDiffs: ctx.filteredDiffs,
          checkedCount: ctx.checkedCount,
          totalCount: ctx.totalCount,
          toggleAll: ctx.toggleAll,
          hasFolders: ctx.hasFolders,
          allFoldersCollapsed: ctx.allFoldersCollapsed,
          collapsedFolders: ctx.collapsedFolders,
          handleCollapseAllFolders: ctx.handleCollapseAllFolders,
          handleExpandAllFolders: ctx.handleExpandAllFolders,
          loading: ctx.loading,
          loadError: ctx.loadError,
          refresh: ctx.refresh,
          fileSearch: ctx.fileSearch,
          treeRows: ctx.treeRows,
          selectedFile: ctx.selectedFile,
          setSelectedFile: ctx.setSelectedFile,
          expandedFile: ctx.expandedFile,
          setExpandedFile: ctx.setExpandedFile,
          loadDiffForFile: ctx.loadDiffForFile,
          checkedFiles: ctx.checkedFiles,
          toggleFile: ctx.toggleFile,
          toggleFolder: ctx.toggleFolder,
          toggleSubmodule: ctx.toggleSubmodule,
          expandedSubmodules: ctx.expandedSubmodules,
          fileSelectionState: ctx.fileSelectionState,
          setFileSelectionState: ctx.setFileSelectionState,
          setSelectAllSignal: ctx.setSelectAllSignal,
          setDeselectAllSignal: ctx.setDeselectAllSignal,
          handleStageFile: ctx.handleStageFile,
          handleUnstageFile: ctx.handleUnstageFile,
          handleRevertFile: ctx.handleRevertFile,
          handleDiscardFolder: ctx.handleDiscardFolder,
          handleIgnore: ctx.handleIgnore,
          handleCopyPath: ctx.handleCopyPath,
          handleOpenDirectory: ctx.handleOpenDirectory,
          basePath: ctx.basePath,
          readOnly: ctx.viewerReadOnly,
        }}
        commitDraft={{
          commitEntry: ctx.commitEntry,
          commitProgressId: ctx.commitProgressId,
          setActionInProgress: ctx.setActionInProgress,
          summaries: ctx.summaries,
          commitInProgress: ctx.commitInProgress,
          commitTitle: ctx.commitTitle,
          commitBody: ctx.commitBody,
          setCommitTitle: ctx.setCommitTitle,
          setCommitBody: ctx.setCommitBody,
          generatingMsg: ctx.generatingMsg,
          handleGenerateCommitMsg: ctx.handleGenerateCommitMsg,
          selectedAction: ctx.selectedAction,
          setSelectedAction: ctx.setSelectedAction,
          actionInProgress: ctx.actionInProgress,
          isOnDifferentBranch: ctx.isOnDifferentBranch,
          gitStatus: ctx.gitStatus,
          canCommit: ctx.canCommit,
          handleCommitAction: ctx.handleCommitAction,
          isAgentRunning: ctx.isAgentRunning,
          effectiveThreadId: ctx.effectiveThreadId,
          hasRebaseConflict: ctx.hasRebaseConflict,
          baseBranch: ctx.baseBranch,
          isWorktree: ctx.isWorktree,
          handleOpenInEditorConflict: ctx.handleOpenInEditorConflict,
          handleAskAgentResolve: ctx.handleAskAgentResolve,
          readOnly: ctx.viewerReadOnly,
        }}
      />
    </div>
  );
}

/** Dockview panel: History — self-contained, just renders CommitHistoryTab. */
export function HistoryPanel() {
  return (
    <div className="flex h-full w-full flex-col text-xs">
      <CommitHistoryTab visible />
    </div>
  );
}

/** Dockview panel: Graph — branch-graph history view. */
export function GraphPanel() {
  return (
    <div className="flex h-full w-full flex-col text-xs">
      <CommitGraphTab visible />
    </div>
  );
}

/** Dockview panel: Stash — reads stash state from context. */
export function StashPanel() {
  const ctx = useReviewPaneContext();
  return (
    <div className="flex h-full w-full flex-col text-xs">
      <StashTab
        stash={ctx.stash}
        currentBranch={ctx.currentBranch}
        isAgentRunning={ctx.isAgentRunning}
        onRequestDrop={(stashIndex) => ctx.setConfirmDialog({ type: 'drop-stash', stashIndex })}
      />
    </div>
  );
}

/** Dockview panel: Pull Requests — self-contained. */
export function PRsPanel() {
  return (
    <div className="flex h-full w-full flex-col text-xs">
      <PullRequestsTab visible />
    </div>
  );
}

/** Dockview panel: Issues — self-contained. */
export function IssuesPanel() {
  return (
    <div className="flex h-full w-full flex-col text-xs">
      <IssuesTab visible />
    </div>
  );
}
