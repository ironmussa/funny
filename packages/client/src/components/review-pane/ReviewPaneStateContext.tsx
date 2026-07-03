import { FileCode, FilePlus, FileWarning, FileX } from 'lucide-react';
import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { resolveBasePath } from '@/components/review-pane/resolve-base-path';
import { useReviewState } from '@/hooks/use-review-state';
import { useRightPaneProjectId, useRightPaneThreadId } from '@/hooks/use-right-pane-target';
import { useThreadById } from '@/lib/thread-selectors';
import { canLoadGitHistory } from '@/lib/thread-variant';
import { resolveThreadBranch } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth-store';
import {
  useGitStatusStore,
  useGitStatusForThread,
  type ProjectGitStatus,
} from '@/stores/git-status-store';
import { usePRDetail } from '@/stores/pr-detail-store';
import { useProjectStore } from '@/stores/project-store';
import {
  useThreadProjectId,
  useThreadSelector,
  useThreadStatus,
  useThreadWorktreePath,
} from '@/stores/thread-context';
import { useUIStore, type ReviewSubTab } from '@/stores/ui-store';

import { ExpandedDiffPresenter } from './ExpandedDiffPresenter';
import { ReviewDialogs, type ConfirmDialogState } from './ReviewDialogs';

const fileStatusIcons: Record<string, typeof FileCode> = {
  added: FilePlus,
  modified: FileCode,
  deleted: FileX,
  renamed: FileCode,
  conflicted: FileWarning,
};

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
  const navigate = useNavigate();
  const { pathname, search: locationSearch } = useLocation();

  // ── Stores ──
  const setReviewPaneOpen = useUIStore((s) => s.setReviewPaneOpen);
  const reviewPaneOpen = useUIStore((s) => s.reviewPaneOpen);
  const reviewSubTab = useUIStore((s) => s.reviewSubTab);
  const setReviewSubTabStore = useUIStore((s) => s.setReviewSubTab);
  const selectedProjectId = useRightPaneProjectId();

  const selectedThreadId = useRightPaneThreadId();
  const effectiveThreadId = selectedThreadId || undefined;
  const projectModeId = !effectiveThreadId ? selectedProjectId : null;

  const worktreePath = useThreadWorktreePath();
  const threadProjectId = useThreadProjectId();
  const projectsForPath = useProjectStore((s) => s.projects);
  const lightThread = useThreadById(selectedThreadId ?? undefined);
  const threadIsScratch = useThreadSelector((t) => t?.isScratch);
  const gitThread = effectiveThreadId
    ? {
        projectId: threadProjectId ?? lightThread?.projectId ?? '',
        isScratch: threadIsScratch ?? lightThread?.isScratch,
      }
    : null;
  const hasGitContext = !!projectModeId || canLoadGitHistory(gitThread);
  const gitContextKey = `${effectiveThreadId || projectModeId || ''}::${
    gitThread?.projectId ?? projectModeId ?? ''
  }`;
  const basePath = useMemo(
    () =>
      resolveBasePath({
        worktreePath,
        lightThread,
        threadProjectId,
        selectedProjectId,
        projects: projectsForPath,
      }),
    [worktreePath, lightThread, threadProjectId, selectedProjectId, projectsForPath],
  );

  const isWorktree = useThreadSelector((t) => t?.mode === 'worktree');
  const baseBranch = useThreadSelector((t) => t?.baseBranch);
  const threadBranch = useThreadSelector((t) => {
    if (!t) return undefined;
    if (t.mode !== 'worktree') return undefined;
    return resolveThreadBranch(t);
  });
  const projectBranch = useProjectStore((s) => {
    const pid = projectModeId ?? gitThread?.projectId;
    return pid ? s.branchByProject[pid] : undefined;
  });
  const currentBranch = threadBranch || projectBranch;

  const isAgentRunning = useThreadStatus() === 'running';
  const threadGitStatus = useGitStatusForThread(effectiveThreadId);
  const projectGitStatus = useGitStatusStore((s) =>
    projectModeId ? s.statusByProject[projectModeId] : undefined,
  );
  const gitStatus = threadGitStatus ?? projectGitStatus;
  const prProjectId = projectModeId ?? gitThread?.projectId ?? '';
  const { threads: prThreads } = usePRDetail(
    prProjectId || undefined,
    gitStatus?.prNumber ?? undefined,
  );
  const unpushedCommitCount = gitStatus?.unpushedCommitCount ?? 0;
  const remoteCheckProjectId = projectModeId ?? gitThread?.projectId ?? null;

  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);

  // A non-owner viewer (necessarily a `steer` sharee — `view` sharees can't open
  // the pane) gets a read-only review pane. In project-mode (no thread owner) or
  // while auth loads, this is false, so the owner never loses write controls.
  const selfUserId = useAuthStore((s) => s.user?.id ?? null);
  const threadOwnerId = useThreadSelector((t) => t?.userId ?? null);
  const viewerReadOnly = !!selfUserId && !!threadOwnerId && threadOwnerId !== selfUserId;

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
  const refreshReview = review.refresh;

  const refreshAll = useCallback(async () => {
    const gitStore = useGitStatusStore.getState();
    if (effectiveThreadId) {
      void gitStore.fetchForThread(effectiveThreadId, true);
      if (threadProjectId) void gitStore.fetchForProject(threadProjectId, true);
    } else if (projectModeId) {
      void gitStore.fetchProjectStatus(projectModeId, true);
      void gitStore.fetchForProject(projectModeId, true);
    }
    await refreshReview();
  }, [effectiveThreadId, projectModeId, threadProjectId, refreshReview]);

  // Sync the active sub-tab with the URL query param. Kept here rather than in
  // a hook so that dockview tab clicks (which call this) and URL navigation
  // share one source of truth.
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
      isAgentRunning: !!isAgentRunning,
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
      viewerReadOnly,
    ],
  );

  // Compute expanded-diff helpers needed by the global DiffViewerModal.
  const expandedFile = review.expandedFile;
  const expandedSummary = expandedFile
    ? review.summaries.find((s) => s.path === expandedFile)
    : undefined;
  const expandedDiffContent = expandedFile ? review.diffCache.get(expandedFile) : undefined;
  const ExpandedIcon = expandedSummary
    ? fileStatusIcons[expandedSummary.status] || FileCode
    : FileCode;

  const handleExpandedFileSelect = useCallback(
    (path: string) => {
      review.setExpandedFile(path);
      review.setSelectedFile(path);
      review.loadDiffForFile(path);
    },
    [review],
  );
  const handleExpandedClose = useCallback(() => review.setExpandedFile(null), [review]);

  return (
    <ReviewPaneContext.Provider value={value}>
      {children}
      {/* Both overlays Radix-portal to document.body, so positioning them here
          is fine regardless of where the tabs render. */}
      <ExpandedDiffPresenter
        expandedFile={expandedFile}
        expandedSummary={expandedSummary}
        expandedDiffContent={expandedDiffContent}
        ExpandedIcon={ExpandedIcon}
        onClose={handleExpandedClose}
        onFileSelect={handleExpandedFileSelect}
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
