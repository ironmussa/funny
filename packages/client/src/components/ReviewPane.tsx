import { FileCode, FilePlus, FileWarning, FileX, PanelRightClose } from 'lucide-react';
import { useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useReviewState } from '@/hooks/use-review-state';
import { resolveThreadBranch } from '@/lib/utils';
import { useGitStatusStore, useGitStatusForThread } from '@/stores/git-status-store';
import { usePRDetail } from '@/stores/pr-detail-store';
import { useProjectStore } from '@/stores/project-store';
import {
  useThreadProjectId,
  useThreadSelector,
  useThreadStatus,
  useThreadWorktreePath,
} from '@/stores/thread-context';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore, type ReviewSubTab } from '@/stores/ui-store';

import { CommitHistoryTab } from './CommitHistoryTab';
import { PullRequestsTab } from './PullRequestsTab';
import { DiffViewerModal } from './review-pane/DiffViewerModal';
import { ReviewChangesTab } from './review-pane/ReviewChangesTab';
import { ReviewDialogs, type ConfirmDialogState } from './review-pane/ReviewDialogs';
import { StashTab } from './review-pane/StashTab';

const fileStatusIcons: Record<string, typeof FileCode> = {
  added: FilePlus,
  modified: FileCode,
  deleted: FileX,
  renamed: FileCode,
  conflicted: FileWarning,
};

export function ReviewPane() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname, search: locationSearch } = useLocation();

  // ── Stores ──
  const setReviewPaneOpen = useUIStore((s) => s.setReviewPaneOpen);
  const reviewPaneOpen = useUIStore((s) => s.reviewPaneOpen);
  const reviewSubTab = useUIStore((s) => s.reviewSubTab);
  const setReviewSubTabStore = useUIStore((s) => s.setReviewSubTab);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);

  // selectedThreadId updates immediately on thread click (before the thread
  // data loads), so git fetches start ~1-2s sooner than waiting for activeThread.
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId);
  const effectiveThreadId = selectedThreadId || undefined;
  const projectModeId = !effectiveThreadId ? selectedProjectId : null;
  const hasGitContext = !!(effectiveThreadId || projectModeId);
  const gitContextKey = effectiveThreadId || projectModeId;

  const worktreePath = useThreadWorktreePath();
  const threadProjectId = useThreadProjectId();
  const projectsForPath = useProjectStore((s) => s.projects);
  const basePath = useMemo(() => {
    if (worktreePath) return worktreePath;
    const pid = threadProjectId ?? selectedProjectId;
    if (!pid) return '';
    return projectsForPath.find((p) => p.id === pid)?.path ?? '';
  }, [worktreePath, threadProjectId, selectedProjectId, projectsForPath]);

  const isWorktree = useThreadSelector((t) => t?.mode === 'worktree');
  const baseBranch = useThreadSelector((t) => t?.baseBranch);
  // Worktree threads track their own branch; local threads share the project's
  // working directory, so their "current branch" is the project's branch.
  const threadBranch = useThreadSelector((t) => {
    if (!t) return undefined;
    if (t.mode !== 'worktree') return undefined;
    return resolveThreadBranch(t);
  });
  const projectBranch = useProjectStore((s) => {
    const pid = projectModeId ?? threadProjectId;
    return pid ? s.branchByProject[pid] : undefined;
  });
  const currentBranch = threadBranch || projectBranch;

  const isAgentRunning = useThreadStatus() === 'running';
  const threadGitStatus = useGitStatusForThread(effectiveThreadId);
  const projectGitStatus = useGitStatusStore((s) =>
    projectModeId ? s.statusByProject[projectModeId] : undefined,
  );
  const gitStatus = threadGitStatus ?? projectGitStatus;
  const prProjectId = threadProjectId ?? selectedProjectId ?? '';
  const { threads: prThreads } = usePRDetail(
    prProjectId || undefined,
    gitStatus?.prNumber ?? undefined,
  );
  const unpushedCommitCount = gitStatus?.unpushedCommitCount ?? 0;

  // remoteCheckProjectId resolves either the project-mode id or the active
  // thread's project (worktrees share git config with the project).
  const remoteCheckProjectId = projectModeId ?? threadProjectId ?? null;

  // ── UI-local state (orchestrator-only) ──
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);

  // ── Aggregated review state (8 hooks + selection state + lifecycle effects) ──
  const review = useReviewState({
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
    isAgentRunning: !!isAgentRunning,
    gitStatus,
    unpushedCommitCount,
    remoteCheckProjectId,
    reviewPaneOpen,
    reviewSubTab,
    setReviewPaneOpen,
    setConfirmDialog,
  });
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

  // ── Sync active sub-tab with URL query param ──
  const setReviewSubTab = useCallback(
    (tab: ReviewSubTab) => {
      setReviewSubTabStore(tab);
      const params = new URLSearchParams(locationSearch);
      if (tab === 'changes') {
        params.delete('tab');
      } else {
        params.set('tab', tab);
      }
      const search = params.toString();
      navigate(`${pathname}${search ? `?${search}` : ''}`, { replace: true });
    },
    [setReviewSubTabStore, pathname, locationSearch, navigate],
  );

  // Stable callbacks for ExpandedDiffView — avoids re-renders from new closures
  const handleExpandedFileSelect = useCallback(
    (path: string) => {
      setExpandedFile(path);
      setSelectedFile(path);
      loadDiffForFile(path);
    },
    [loadDiffForFile, setExpandedFile, setSelectedFile],
  );

  const handleExpandedClose = useCallback(() => setExpandedFile(null), [setExpandedFile]);

  // Compute expanded diff props once (used in the overlay below)
  const expandedSummary = expandedFile ? summaries.find((s) => s.path === expandedFile) : undefined;
  const expandedDiffContent = expandedFile ? diffCache.get(expandedFile) : undefined;
  const ExpandedIcon = expandedSummary
    ? fileStatusIcons[expandedSummary.status] || FileCode
    : FileCode;

  return (
    <div className="flex h-full flex-col">
      <DiffViewerModal
        expandedFile={expandedFile}
        expandedSummary={expandedSummary}
        expandedDiffContent={expandedDiffContent}
        ExpandedIcon={ExpandedIcon}
        onClose={handleExpandedClose}
        onFileSelect={handleExpandedFileSelect}
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
        <div className="flex h-12 items-center justify-between border-b border-sidebar-border px-2">
          <TabsList className="h-7 bg-sidebar-accent/50 p-0.5">
            <TabsTrigger
              value="changes"
              className="h-6 px-2.5 data-[state=active]:bg-background data-[state=active]:shadow-sm"
              data-testid="review-tab-changes"
            >
              {t('review.changes', 'Changes')}
            </TabsTrigger>
            <TabsTrigger
              value="history"
              className="h-6 px-2.5 data-[state=active]:bg-background data-[state=active]:shadow-sm"
              data-testid="review-tab-history"
            >
              {t('review.history', 'History')}
            </TabsTrigger>
            <TabsTrigger
              value="stash"
              className="h-6 px-2.5 data-[state=active]:bg-background data-[state=active]:shadow-sm"
              data-testid="review-tab-stash"
            >
              {t('review.stash', 'Stash')}
            </TabsTrigger>
            <TabsTrigger
              value="prs"
              className="h-6 px-2.5 data-[state=active]:bg-background data-[state=active]:shadow-sm"
              data-testid="review-tab-prs"
            >
              {t('review.prs', 'PRs')}
            </TabsTrigger>
          </TabsList>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setReviewPaneOpen(false)}
                className="text-muted-foreground"
                data-testid="review-close"
              >
                <PanelRightClose className="icon-base" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t('review.close', 'Close')}</TooltipContent>
          </Tooltip>
        </div>

        <ReviewChangesTab
          truncatedInfo={truncatedInfo}
          summaries={summaries}
          prSummary={
            gitStatus?.prNumber
              ? {
                  projectId: threadProjectId ?? selectedProjectId ?? '',
                  prNumber: gitStatus.prNumber,
                  prUrl: gitStatus.prUrl ?? '',
                  prState: gitStatus.prState ?? 'OPEN',
                  visible: reviewSubTab === 'changes' && reviewPaneOpen,
                }
              : null
          }
          search={{
            query: fileSearch,
            onQueryChange: setFileSearch,
            placeholder: t('review.searchFiles', 'Filter files…'),
            totalMatches: filteredDiffs.length,
            resultLabel: fileSearch ? `${filteredDiffs.length}/${summaries.length}` : '',
            caseSensitive: fileSearchCaseSensitive,
            onCaseSensitiveChange: setFileSearchCaseSensitive,
            onClose: fileSearch ? () => setFileSearch('') : undefined,
            autoFocus: false,
            testIdPrefix: 'review-file-filter',
          }}
          toolbar={{
            refresh,
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
          }}
        />

        {/* History tab */}
        <TabsContent
          value="history"
          className="flex min-h-0 flex-1 data-[state=inactive]:hidden"
          forceMount
        >
          <CommitHistoryTab visible={reviewSubTab === 'history'} />
        </TabsContent>

        {/* Stash tab */}
        <TabsContent
          value="stash"
          className="flex min-h-0 flex-1 data-[state=inactive]:hidden"
          forceMount
        >
          <StashTab
            stash={stash}
            currentBranch={currentBranch}
            isAgentRunning={!!isAgentRunning}
            onRequestDrop={(stashIndex) => setConfirmDialog({ type: 'drop-stash', stashIndex })}
          />
        </TabsContent>

        {/* Pull Requests tab */}
        <TabsContent
          value="prs"
          className="flex min-h-0 flex-1 data-[state=inactive]:hidden"
          forceMount
        >
          <PullRequestsTab visible={reviewSubTab === 'prs'} />
        </TabsContent>
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
