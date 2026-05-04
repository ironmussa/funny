import type { FileDiffSummary } from '@funny/shared';
import { FileCode, FilePlus, FileWarning, FileX, PanelRightClose } from 'lucide-react';
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { PullStrategyDialog } from '@/components/pull-strategy-dialog';
import { Button } from '@/components/ui/button';
import { SearchBar } from '@/components/ui/search-bar';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useCommitDraft } from '@/hooks/use-commit-draft';
import { useCommitWorkflow } from '@/hooks/use-commit-workflow';
import { useDiffData } from '@/hooks/use-diff-data';
import { useFileTreeState } from '@/hooks/use-file-tree-state';
import { useGenerateCommitMsg } from '@/hooks/use-generate-commit-msg';
import { usePublishState } from '@/hooks/use-publish-state';
import { useReviewActions } from '@/hooks/use-review-actions';
import { useStashState } from '@/hooks/use-stash-state';
import { cn, resolveThreadBranch } from '@/lib/utils';
import { useGitStatusStore, useGitStatusForThread } from '@/stores/git-status-store';
import { usePRDetail } from '@/stores/pr-detail-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore, type ReviewSubTab } from '@/stores/ui-store';

import { CommitHistoryTab } from './CommitHistoryTab';
import { PRSummaryCard } from './PRSummaryCard';
import { PublishRepoDialog } from './PublishRepoDialog';
import { PullRequestsTab } from './PullRequestsTab';
import { ChangesFilesPanel } from './review-pane/ChangesFilesPanel';
import { ChangesToolbar } from './review-pane/ChangesToolbar';
import { CommitDraftPanel } from './review-pane/CommitDraftPanel';
import { DiffViewerModal } from './review-pane/DiffViewerModal';
import { CreatePRDialog, MergeBranchDialog } from './review-pane/ReviewActionDialogs';
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
  const location = useLocation();
  const setReviewPaneOpen = useUIStore((s) => s.setReviewPaneOpen);
  const reviewPaneOpen = useUIStore((s) => s.reviewPaneOpen);
  const reviewSubTab = useUIStore((s) => s.reviewSubTab);
  const setReviewSubTabStore = useUIStore((s) => s.setReviewSubTab);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);

  // Use selectedThreadId for git requests — it updates *immediately* when the
  // user clicks a thread in the sidebar (before the thread data loads from the
  // API). This decouples git loading from thread loading so ReviewPane can
  // start fetching status/diff/summary right away instead of waiting 1-2s for
  // the thread data to arrive.
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId);
  const effectiveThreadId = selectedThreadId || undefined;

  // When no thread is active but a project is selected, use project-based git endpoints
  const projectModeId = !effectiveThreadId ? selectedProjectId : null;
  // Either we have a thread or a project — at least one must be set for git operations
  const hasGitContext = !!(effectiveThreadId || projectModeId);

  // The base directory path for constructing absolute file paths (worktree path or project path)
  // NOTE: Avoid calling useProjectStore.getState() inside a useThreadStore selector —
  // it triggers "Cannot update a component while rendering a different component" errors.
  const worktreePath = useThreadStore((s) => s.activeThread?.worktreePath);
  const threadProjectId = useThreadStore((s) => s.activeThread?.projectId);
  const projectsForPath = useProjectStore((s) => s.projects);
  const basePath = useMemo(() => {
    if (worktreePath) return worktreePath;
    const pid = threadProjectId ?? selectedProjectId;
    if (!pid) return '';
    return projectsForPath.find((p) => p.id === pid)?.path ?? '';
  }, [worktreePath, threadProjectId, selectedProjectId, projectsForPath]);

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
  const [confirmDialog, setConfirmDialog] = useState<{
    type: 'revert' | 'reset' | 'discard-all' | 'drop-stash' | 'ignore';
    path?: string;
    paths?: string[];
    stashIndex?: string;
  } | null>(null);

  const isWorktree = useThreadStore((s) => s.activeThread?.mode === 'worktree');
  const baseBranch = useThreadStore((s) => s.activeThread?.baseBranch);
  // Worktree threads track their own branch; local threads share the project's
  // working directory, so their "current branch" is whatever the project is on.
  const threadBranch = useThreadStore((s) => {
    if (!s.activeThread) return undefined;
    if (s.activeThread.mode !== 'worktree') return undefined;
    return resolveThreadBranch(s.activeThread);
  });
  const projectBranch = useProjectStore((s) => {
    const pid = projectModeId ?? threadProjectId;
    return pid ? s.branchByProject[pid] : undefined;
  });
  const currentBranch = threadBranch || projectBranch;

  const _hasWorktreePath = useThreadStore((s) => !!s.activeThread?.worktreePath);
  const isAgentRunning = useThreadStore((s) => s.activeThread?.status === 'running');
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
  // Derive unpushed count from gitStatus store (populated by git/status endpoint).
  const unpushedCommitCount = gitStatus?.unpushedCommitCount ?? 0;

  // Publish repository state — detect repos with no remote origin
  // remoteCheckProjectId resolves either the project-mode id or the active
  // thread's project (worktrees share git config with the project).
  const remoteCheckProjectId = projectModeId ?? threadProjectId ?? null;
  const { remoteUrl, publishDialogOpen, setPublishDialogOpen, handlePublishSuccess } =
    usePublishState({
      remoteCheckProjectId,
      hasRemoteBranch: gitStatus?.hasRemoteBranch,
    });

  // Whether the thread is on a different branch from base (worktree or local mode)
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

  // Diff data lifecycle (summary + per-file load + full-context fetch + the
  // 3 effects that trigger loads when file selection changes or pane opens).
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

  // Reset state and refresh when the active thread or project-mode changes,
  // or when the project branch changes (e.g. after a checkout from the BranchPicker).
  // Using effectiveThreadId (not just gitContextKey) ensures we refresh even
  // when switching between two local threads of the same project that share
  // the same git working directory.
  const gitContextKey = effectiveThreadId || projectModeId;

  // Stash state + ops live in their own hook to keep ReviewPane focused.
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

  // Commit / push / PR / merge workflow — owns the in-progress flags, the
  // dialogs, the rebase-conflict flag, and the watcher that clears them.
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

  // Action handlers — staging, discard/ignore, pull/fetch, stash creation,
  // reset, conflict resolution, copy/open. All co-located here so the bulk
  // of the api+toast scaffolding lives outside ReviewPane.
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

  // Auto-close the review pane when the branch becomes fully clean after a workflow
  // (commit-push, push, merge, etc.). This avoids leaving an empty "No changes" pane.
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
  ]);

  useEffect(() => {
    // Abort any in-flight git requests from the previous thread/project.
    // This is the key fix for progressive slowdown: without this, each thread
    // switch piles up 5-6 git requests that saturate the server's process pool.
    abortRef.current?.abort();
    // Also abort any in-flight commit message generation so it doesn't write
    // stale results back to local state after the thread switch.
    abortGenerate();

    setSummaries([]);
    setDiffCache(new Map());
    setSelectedFile(null);
    setCheckedFiles(new Set());
    setFileSearch('');
    setHasRebaseConflict(false);
    setLoadError(false);
    setSelectedAction('commit');

    // Commit title/body are restored automatically by useCommitDraft when
    // draftId (= gitContextKey) changes.

    // Only fetch data if the pane is visible; otherwise defer until it opens.
    if (reviewPaneOpen) {
      refresh();
    } else {
      needsRefreshRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset+refresh on context change only; refresh/reviewPaneOpen are read but not deps (handled separately)
  }, [gitContextKey, currentBranch]);

  // Reset selectedAction if "commit-pr" is selected but a PR already exists.
  useEffect(() => {
    if (selectedAction === 'commit-pr' && gitStatus?.prNumber) {
      setSelectedAction('commit');
    }
  }, [selectedAction, gitStatus?.prNumber]);

  const checkedCount = [...checkedFiles].filter((p) => visiblePaths.has(p)).length;
  const totalCount = visibleFiles.length;

  const toggleFile = (path: string) => {
    setCheckedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleAll = () => {
    const targetPaths = visiblePaths;
    const allChecked = [...targetPaths].every((p) => checkedFiles.has(p));
    if (allChecked) {
      // Uncheck only the visible (filtered) files, keep others checked
      setCheckedFiles((prev) => {
        const next = new Set(prev);
        for (const p of targetPaths) next.delete(p);
        return next;
      });
    } else {
      // Check all visible (filtered) files, keep existing checked
      setCheckedFiles((prev) => new Set([...prev, ...targetPaths]));
    }
  };

  // ── Sync active sub-tab with URL query param ──
  const setReviewSubTab = useCallback(
    (tab: ReviewSubTab) => {
      setReviewSubTabStore(tab);
      // Update ?tab= query param in URL
      const params = new URLSearchParams(location.search);
      if (tab === 'changes') {
        params.delete('tab');
      } else {
        params.set('tab', tab);
      }
      const search = params.toString();
      navigate(`${location.pathname}${search ? `?${search}` : ''}`, { replace: true });
    },
    [setReviewSubTabStore, location.pathname, location.search, navigate],
  );

  // When a thread is active, commits are delegated to the agent, so allow even if agent is running
  const canCommit =
    checkedFiles.size > 0 &&
    commitTitle.trim().length > 0 &&
    !actionInProgress &&
    (effectiveThreadId ? true : !isAgentRunning);

  // Stable callbacks for ExpandedDiffView — avoids re-renders from new closures
  const handleExpandedFileSelect = useCallback(
    (path: string) => {
      setExpandedFile(path);
      setSelectedFile(path);
      loadDiffForFile(path);
    },
    [loadDiffForFile],
  );

  const handleExpandedClose = useCallback(() => setExpandedFile(null), []);

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

        {/* Changes tab */}
        <TabsContent
          value="changes"
          className="flex min-h-0 flex-1 data-[state=inactive]:hidden"
          forceMount
        >
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              {/* Truncation warning */}
              {truncatedInfo.truncated && (
                <div className="border-b border-sidebar-border bg-yellow-500/10 px-3 py-1.5 text-xs text-yellow-600 dark:text-yellow-400">
                  {t('review.truncatedWarning', {
                    shown: summaries.length,
                    total: truncatedInfo.total,
                    defaultValue: `Showing ${summaries.length} of ${truncatedInfo.total} files. Some files were excluded.`,
                  })}
                </div>
              )}

              {/* PR Summary Card */}
              {gitStatus?.prNumber && (
                <PRSummaryCard
                  projectId={threadProjectId ?? selectedProjectId ?? ''}
                  prNumber={gitStatus.prNumber}
                  prUrl={gitStatus.prUrl ?? ''}
                  prState={gitStatus.prState ?? 'OPEN'}
                  visible={reviewSubTab === 'changes' && reviewPaneOpen}
                />
              )}

              {/* Toolbar icons */}
              <ChangesToolbar
                refresh={refresh}
                loading={loading}
                handlePull={handlePull}
                handleFetchOrigin={handleFetchOrigin}
                pullInProgress={pullInProgress}
                fetchInProgress={fetchInProgress}
                handlePushOnly={handlePushOnly}
                pushInProgress={pushInProgress}
                remoteUrl={remoteUrl}
                setPublishDialogOpen={setPublishDialogOpen}
                unpushedCommitCount={unpushedCommitCount}
                threadBranch={threadBranch}
                baseBranch={baseBranch}
                isOnDifferentBranch={isOnDifferentBranch}
                openMergeDialog={openMergeDialog}
                mergeInProgress={mergeInProgress}
                setPrDialog={setPrDialog}
                summaries={summaries}
                checkedFiles={checkedFiles}
                handleStageSelected={handleStageSelected}
                handleUnstageAll={handleUnstageAll}
                handleStashSelected={handleStashSelected}
                handleDiscardAll={handleDiscardAll}
                handleIgnoreFiles={handleIgnoreFiles}
                actionInProgress={actionInProgress}
                stashInProgress={stashInProgress}
                gitStatus={gitStatus}
                isAgentRunning={isAgentRunning}
              />

              {/* File search */}
              {summaries.length > 0 && (
                <div className="border-b border-sidebar-border px-2 py-1">
                  <SearchBar
                    query={fileSearch}
                    onQueryChange={setFileSearch}
                    placeholder={t('review.searchFiles', 'Filter files\u2026')}
                    totalMatches={filteredDiffs.length}
                    resultLabel={fileSearch ? `${filteredDiffs.length}/${summaries.length}` : ''}
                    caseSensitive={fileSearchCaseSensitive}
                    onCaseSensitiveChange={setFileSearchCaseSensitive}
                    onClose={fileSearch ? () => setFileSearch('') : undefined}
                    autoFocus={false}
                    testIdPrefix="review-file-filter"
                  />
                </div>
              )}

              <ChangesFilesPanel
                summaries={summaries}
                filteredDiffs={filteredDiffs}
                checkedCount={checkedCount}
                totalCount={totalCount}
                toggleAll={toggleAll}
                hasFolders={hasFolders}
                allFoldersCollapsed={allFoldersCollapsed}
                collapsedFolders={collapsedFolders}
                handleCollapseAllFolders={handleCollapseAllFolders}
                handleExpandAllFolders={handleExpandAllFolders}
                loading={loading}
                loadError={loadError}
                refresh={refresh}
                fileSearch={fileSearch}
                treeRows={treeRows}
                selectedFile={selectedFile}
                setSelectedFile={setSelectedFile}
                expandedFile={expandedFile}
                setExpandedFile={setExpandedFile}
                checkedFiles={checkedFiles}
                toggleFile={toggleFile}
                toggleFolder={toggleFolder}
                toggleSubmodule={toggleSubmodule}
                expandedSubmodules={expandedSubmodules}
                fileSelectionState={fileSelectionState}
                setFileSelectionState={setFileSelectionState}
                setSelectAllSignal={setSelectAllSignal}
                setDeselectAllSignal={setDeselectAllSignal}
                handleStageFile={handleStageFile}
                handleUnstageFile={handleUnstageFile}
                handleRevertFile={handleRevertFile}
                handleIgnore={handleIgnore}
                handleCopyPath={handleCopyPath}
                handleOpenDirectory={handleOpenDirectory}
                basePath={basePath}
              />

              <CommitDraftPanel
                commitEntry={commitEntry}
                commitProgressId={commitProgressId}
                setActionInProgress={setActionInProgress}
                summaries={summaries}
                commitInProgress={commitInProgress}
                commitTitle={commitTitle}
                commitBody={commitBody}
                setCommitTitle={setCommitTitle}
                setCommitBody={setCommitBody}
                generatingMsg={generatingMsg}
                handleGenerateCommitMsg={handleGenerateCommitMsg}
                selectedAction={selectedAction}
                setSelectedAction={setSelectedAction}
                actionInProgress={actionInProgress}
                isOnDifferentBranch={isOnDifferentBranch}
                gitStatus={gitStatus}
                canCommit={canCommit}
                handleCommitAction={handleCommitAction}
                isAgentRunning={isAgentRunning}
                effectiveThreadId={effectiveThreadId}
                hasRebaseConflict={hasRebaseConflict}
                baseBranch={baseBranch}
                isWorktree={isWorktree}
                handleOpenInEditorConflict={handleOpenInEditorConflict}
                handleAskAgentResolve={handleAskAgentResolve}
              />
            </div>
          </div>
        </TabsContent>

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

        {/* Confirmation dialog for destructive actions */}
        <ConfirmDialog
          open={!!confirmDialog}
          onOpenChange={(open) => {
            if (!open) setConfirmDialog(null);
          }}
          title={
            confirmDialog?.type === 'revert' || confirmDialog?.type === 'discard-all'
              ? t('review.discardChanges', 'Discard changes')
              : confirmDialog?.type === 'ignore'
                ? 'Add to .gitignore'
                : confirmDialog?.type === 'drop-stash'
                  ? t('review.dropStashTitle', 'Discard stash')
                  : t('review.undoLastCommit', 'Undo last commit')
          }
          description={
            confirmDialog?.type === 'revert'
              ? t('review.revertConfirm', { paths: confirmDialog?.path })
              : confirmDialog?.type === 'discard-all'
                ? t('review.discardAllConfirm', {
                    count: confirmDialog?.paths?.length,
                    defaultValue: `Discard changes in ${confirmDialog?.paths?.length} file(s)? This cannot be undone.`,
                  })
                : confirmDialog?.type === 'ignore'
                  ? `Add ${confirmDialog?.paths?.length} file(s) to .gitignore?`
                  : confirmDialog?.type === 'drop-stash'
                    ? t('review.dropStashConfirm', 'Drop this stash entry? This cannot be undone.')
                    : t('review.resetSoftConfirm', 'Undo the last commit? Changes will be kept.')
          }
          cancelLabel={t('common.cancel', 'Cancel')}
          confirmLabel={t('common.confirm', 'Confirm')}
          onCancel={() => setConfirmDialog(null)}
          onConfirm={async () => {
            const dialog = confirmDialog;
            setConfirmDialog(null);
            if (dialog?.type === 'revert' && dialog.path) {
              await executeRevert(dialog.path);
            } else if (dialog?.type === 'discard-all' && dialog.paths) {
              await executeDiscardAll(dialog.paths);
            } else if (dialog?.type === 'reset') {
              await executeResetSoft();
            } else if (dialog?.type === 'ignore' && dialog.paths) {
              await executeIgnoreFiles(dialog.paths);
            } else if (dialog?.type === 'drop-stash' && dialog.stashIndex != null) {
              await stash.executeStashDrop(dialog.stashIndex);
            }
          }}
        />

        {/* Strategy picker shown when fast-forward pull fails due to diverged branches */}
        <PullStrategyDialog
          open={pullStrategyDialog.open}
          onOpenChange={(open) => setPullStrategyDialog((s) => ({ ...s, open }))}
          errorMessage={pullStrategyDialog.errorMessage}
          onChoose={handlePullStrategyChosen}
        />

        <CreatePRDialog
          prDialog={prDialog}
          setPrDialog={setPrDialog}
          threadBranch={threadBranch}
          baseBranch={baseBranch}
          prInProgress={prInProgress}
          handleCreatePROnly={handleCreatePROnly}
        />

        <MergeBranchDialog
          mergeDialog={mergeDialog}
          setMergeDialog={setMergeDialog}
          currentBranch={currentBranch}
          mergeInProgress={mergeInProgress}
          handleMergeWithTarget={handleMergeWithTarget}
        />
      </Tabs>

      <PublishRepoDialog
        projectId={remoteCheckProjectId ?? ''}
        projectPath={basePath}
        open={publishDialogOpen}
        onOpenChange={setPublishDialogOpen}
        onSuccess={handlePublishSuccess}
      />
    </div>
  );
}
