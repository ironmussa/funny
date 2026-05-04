import type { FileDiffSummary } from '@funny/shared';
import { FileCheck2, FileCode, FilePlus, FileWarning, FileX, PanelRightClose } from 'lucide-react';
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { PullStrategyDialog, isDivergedBranchesError } from '@/components/pull-strategy-dialog';
import { Button } from '@/components/ui/button';
import { SearchBar } from '@/components/ui/search-bar';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAutoRefreshDiff } from '@/hooks/use-auto-refresh-diff';
import { useCommitDraft } from '@/hooks/use-commit-draft';
import { useCommitWorkflow } from '@/hooks/use-commit-workflow';
import { useFileTreeState } from '@/hooks/use-file-tree-state';
import { useGenerateCommitMsg } from '@/hooks/use-generate-commit-msg';
import { usePublishState } from '@/hooks/use-publish-state';
import { useStashState } from '@/hooks/use-stash-state';
import { api, type PullStrategy } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { parseDiffOld, parseDiffNew } from '@/lib/diff-parse';
import { toastError } from '@/lib/toast-error';
import { cn, resolveThreadBranch } from '@/lib/utils';
import { useGitStatusStore, useGitStatusForThread } from '@/stores/git-status-store';
import { usePRDetail } from '@/stores/pr-detail-store';
import { useProjectStore } from '@/stores/project-store';
import { useSettingsStore, deriveToolLists } from '@/stores/settings-store';
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

const log = createClientLogger('review-pane');

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
  const [diffCache, setDiffCache] = useState<Map<string, string>>(new Map());
  const [loadingDiff, setLoadingDiff] = useState<string | null>(null);
  const [truncatedInfo, setTruncatedInfo] = useState<{ total: number; truncated: boolean }>({
    total: 0,
    truncated: false,
  });
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
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
  // New git operations state
  const [pullInProgress, setPullInProgress] = useState(false);
  const [pullStrategyDialog, setPullStrategyDialog] = useState<{
    open: boolean;
    errorMessage: string;
  }>({ open: false, errorMessage: '' });
  const [fetchInProgress, setFetchInProgress] = useState(false);
  const [stashInProgress, setStashInProgress] = useState(false);
  const [resetInProgress, setResetInProgress] = useState(false);
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
  const { remoteUrl, setRemoteUrl, publishDialogOpen, setPublishDialogOpen } = usePublishState({
    remoteCheckProjectId,
    hasRemoteBranch: gitStatus?.hasRemoteBranch,
  });

  // Whether the thread is on a different branch from base (worktree or local mode)
  const isOnDifferentBranch =
    !!effectiveThreadId && !!baseBranch && !!threadBranch && threadBranch !== baseBranch;

  // AbortController for in-flight git requests. Aborted when the git context
  // changes (thread/project switch) to prevent piling up stale requests that
  // saturate the server's git process pool and cause progressive slowdown.
  const abortRef = useRef<AbortController | null>(null);

  // Monotonically increasing counter to detect stale refresh results.
  // When a new refresh starts, it captures the current value; if another
  // refresh starts before it finishes, the older one detects the mismatch
  // and bails out instead of overwriting state with stale data.
  const refreshEpochRef = useRef(0);

  // True while refresh() is running — used to suppress the selectedFile
  // effect from firing a duplicate diff/file load (refresh already loads it).
  const refreshingRef = useRef(false);

  const refresh = async () => {
    if (!hasGitContext) return;
    refreshingRef.current = true;
    const epoch = ++refreshEpochRef.current;

    // Abort any in-flight git requests from a previous refresh to prevent
    // piling up stale requests that saturate the server's git process pool.
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const { signal } = ac;

    setLoading(true);
    setLoadError(false);

    // Fire git status refresh in parallel (don't await — it updates its own store).
    // Respects cooldowns — WS git:status events invalidate them when data changes.
    if (effectiveThreadId) useGitStatusStore.getState().fetchForThread(effectiveThreadId);
    else if (projectModeId) useGitStatusStore.getState().fetchProjectStatus(projectModeId);

    const result = effectiveThreadId
      ? await api.getDiffSummary(effectiveThreadId, undefined, undefined, signal)
      : await api.projectDiffSummary(projectModeId!, undefined, undefined, signal);

    // Bail out if a newer refresh has started while we were awaiting
    if (refreshEpochRef.current !== epoch || signal.aborted) {
      refreshingRef.current = false;
      return;
    }

    if (result.isOk()) {
      const data = result.value;

      // Determine which file to load and whether it's cached BEFORE state
      // updates so we can fire the diff request in parallel with React batching.
      const newPaths = new Set(data.files.map((d) => d.path));
      const fileToLoad = selectedFile ?? (data.files.length > 0 ? data.files[0].path : null);
      const fileToLoadSummary = fileToLoad
        ? data.files.find((s) => s.path === fileToLoad)
        : undefined;

      // Check the existing cache (pre-prune) — if the file survived the prune
      // it will still be there, and if it didn't the fetch is needed regardless.
      const needsFetch =
        fileToLoad && fileToLoadSummary && !diffCache.get(fileToLoad) && !signal.aborted;

      // Start diff fetch immediately — don't wait for state updates (parallel)
      let diffPromise: Promise<void> | undefined;
      if (needsFetch) {
        setLoadingDiff(fileToLoad);
        diffPromise = (async () => {
          const diffResult = effectiveThreadId
            ? await api.getFileDiff(effectiveThreadId, fileToLoad, fileToLoadSummary.staged, signal)
            : await api.projectFileDiff(
                projectModeId!,
                fileToLoad,
                fileToLoadSummary.staged,
                signal,
              );
          if (refreshEpochRef.current === epoch && diffResult.isOk()) {
            setDiffCache((prev) => new Map(prev).set(fileToLoad, diffResult.value.diff));
          }
          setLoadingDiff((prev) => (prev === fileToLoad ? null : prev));
        })();
      }

      // State updates run in parallel with the diff fetch above
      setSummaries(data.files);
      setTruncatedInfo({ total: data.total, truncated: data.truncated });
      setDiffCache((prev) => {
        const next = new Map<string, string>();
        for (const [k, v] of prev) {
          if (newPaths.has(k)) next.set(k, v);
        }
        return next;
      });
      setCheckedFiles((prev) => {
        const next = new Set(prev);
        const currentPaths = new Set(data.files.map((d) => d.path));
        for (const f of data.files) {
          if (!prev.has(f.path) && prev.size === 0) {
            next.add(f.path);
          } else if (!prev.has(f.path) && data.files.length > prev.size) {
            next.add(f.path);
          }
        }
        for (const p of prev) {
          if (!currentPaths.has(p)) next.delete(p);
        }
        return next.size === 0 ? new Set(data.files.map((d) => d.path)) : next;
      });
      if (data.files.length > 0 && !selectedFile) {
        setSelectedFile(data.files[0].path);
      }

      // Wait for the in-flight diff fetch to complete before finishing refresh
      if (diffPromise) await diffPromise;
    } else {
      // Don't log abort errors as failures
      if (!signal.aborted) {
        console.error('Failed to load diff summary:', result.error);
        setLoadError(true);
      }
    }
    if (!signal.aborted) setLoading(false);
    refreshingRef.current = false;
  };

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

  // Lazy load diff content for the selected file
  const loadDiffForFile = useCallback(
    async (filePath: string) => {
      if (!hasGitContext || diffCache.has(filePath)) return;
      const submoduleEntry = resolveSubmoduleEntry(filePath);
      const summary = submoduleEntry ? null : summaries.find((s) => s.path === filePath);
      if (!submoduleEntry && !summary) return;
      const signal = abortRef.current?.signal;
      setLoadingDiff(filePath);
      const result = submoduleEntry
        ? effectiveThreadId
          ? await api.getSubmoduleFileDiff(
              effectiveThreadId,
              submoduleEntry.submodulePath,
              submoduleEntry.innerPath,
              submoduleEntry.staged,
              signal,
            )
          : await api.projectSubmoduleFileDiff(
              projectModeId!,
              submoduleEntry.submodulePath,
              submoduleEntry.innerPath,
              submoduleEntry.staged,
              signal,
            )
        : effectiveThreadId
          ? await api.getFileDiff(effectiveThreadId, filePath, summary!.staged, signal)
          : await api.projectFileDiff(projectModeId!, filePath, summary!.staged, signal);
      if (result.isOk() && !signal?.aborted) {
        setDiffCache((prev) => new Map(prev).set(filePath, result.value.diff));
      }
      setLoadingDiff((prev) => (prev === filePath ? null : prev));
    },
    [hasGitContext, diffCache, summaries, effectiveThreadId, projectModeId, resolveSubmoduleEntry],
  );

  // Fetch full-context diff for the "Show full file" toggle
  const requestFullDiff = async (
    path: string,
  ): Promise<{ oldValue: string; newValue: string; rawDiff?: string } | null> => {
    if (!hasGitContext) return null;
    const submoduleEntry = resolveSubmoduleEntry(path);
    const summary = submoduleEntry ? null : summaries.find((s) => s.path === path);
    if (!submoduleEntry && !summary) return null;
    const signal = abortRef.current?.signal;
    const result = submoduleEntry
      ? effectiveThreadId
        ? await api.getSubmoduleFileDiff(
            effectiveThreadId,
            submoduleEntry.submodulePath,
            submoduleEntry.innerPath,
            submoduleEntry.staged,
            signal,
            'full',
          )
        : await api.projectSubmoduleFileDiff(
            projectModeId!,
            submoduleEntry.submodulePath,
            submoduleEntry.innerPath,
            submoduleEntry.staged,
            signal,
            'full',
          )
      : effectiveThreadId
        ? await api.getFileDiff(effectiveThreadId, path, summary!.staged, signal, 'full')
        : await api.projectFileDiff(projectModeId!, path, summary!.staged, signal, 'full');
    if (result.isOk() && !signal?.aborted) {
      return {
        oldValue: parseDiffOld(result.value.diff),
        newValue: parseDiffNew(result.value.diff),
        rawDiff: result.value.diff,
      };
    }
    return null;
  };

  // Load diff when selected file or expanded file changes.
  // Skip when refresh() is running — it already loads the diff for the
  // selected file inline, so firing here would cause a duplicate request.
  useEffect(() => {
    if (selectedFile && !diffCache.has(selectedFile) && !refreshingRef.current) {
      loadDiffForFile(selectedFile);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only trigger on file selection change; diffCache/loadDiffForFile change on every refresh and would cause loops
  }, [selectedFile]);

  useEffect(() => {
    if (expandedFile && !diffCache.has(expandedFile)) {
      loadDiffForFile(expandedFile);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only trigger on expanded file change; diffCache/loadDiffForFile change on every refresh and would cause loops
  }, [expandedFile]);

  // Track whether we need to refresh when the pane becomes visible
  const needsRefreshRef = useRef(false);

  // Track when a dropdown menu closes so we can suppress the parent row click
  const dropdownCloseRef = useRef(0);

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

  // Fire deferred refresh when the review pane becomes visible.
  // Uses requestAnimationFrame to yield to the browser first so it can paint
  // the pane opening animation before we start the async fetch.
  useEffect(() => {
    if (reviewPaneOpen && needsRefreshRef.current) {
      needsRefreshRef.current = false;
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh is a non-memoized function; only trigger on pane visibility change
  }, [reviewPaneOpen]);

  // Auto-refresh diffs when agent modifies files (debounced 2s).
  // Pass reviewPaneOpen so dirty signals that arrive while the pane is hidden
  // trigger an immediate refresh when the pane becomes visible again.
  useAutoRefreshDiff(effectiveThreadId, refresh, 2000, reviewPaneOpen);

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

  const handleRevertFile = (path: string) => {
    setConfirmDialog({ type: 'revert', path });
  };

  const executeRevert = async (path: string) => {
    if (!hasGitContext) return;
    const result = effectiveThreadId
      ? await api.revertFiles(effectiveThreadId, [path])
      : await api.projectRevertFiles(projectModeId!, [path]);
    if (result.isErr()) {
      toast.error(t('review.revertFailed', { message: result.error.message }));
    } else {
      toast.success(t('review.revertSuccess', { path, defaultValue: '{{path}} reverted' }));
      await refresh();
    }
  };

  const handleDiscardAll = () => {
    const paths = checkedFiles.size > 0 ? Array.from(checkedFiles) : summaries.map((s) => s.path);
    if (paths.length === 0) return;
    setConfirmDialog({ type: 'discard-all', paths });
  };

  const executeDiscardAll = async (paths: string[]) => {
    if (!hasGitContext) return;
    const result = effectiveThreadId
      ? await api.revertFiles(effectiveThreadId, paths)
      : await api.projectRevertFiles(projectModeId!, paths);
    if (result.isErr()) {
      toast.error(t('review.revertFailed', { message: result.error.message }));
    } else {
      toast.success(
        t('review.discardSuccess', {
          count: paths.length,
          defaultValue: '{{count}} file(s) discarded',
        }),
      );
      await refresh();
    }
  };

  const handleIgnoreFiles = () => {
    const paths = checkedFiles.size > 0 ? Array.from(checkedFiles) : summaries.map((s) => s.path);
    if (paths.length === 0) return;
    setConfirmDialog({ type: 'ignore', paths });
  };

  const executeIgnoreFiles = async (paths: string[]) => {
    if (!hasGitContext) return;
    const result = effectiveThreadId
      ? await api.addPatternsToGitignore(effectiveThreadId, paths)
      : await api.projectAddPatternsToGitignore(projectModeId!, paths);
    if (result.isErr()) {
      toast.error(`Failed to update .gitignore: ${result.error.message}`);
    } else {
      toast.success(`${paths.length} path(s) added to .gitignore`);
      await refresh();
    }
  };

  const handleResolveConflict = useCallback(
    async (blockId: number, resolution: 'ours' | 'theirs' | 'both') => {
      const filePath = expandedFile || selectedFile;
      if (!filePath || !hasGitContext) return;

      const resolutionLabel =
        resolution === 'ours' ? 'current' : resolution === 'theirs' ? 'incoming' : 'both';
      const result = effectiveThreadId
        ? await api.resolveConflict(effectiveThreadId, filePath, blockId, resolution)
        : await api.projectResolveConflict(projectModeId!, filePath, blockId, resolution);

      if (result.isErr()) {
        toast.error(`Failed to resolve conflict: ${result.error.message}`);
      } else {
        toast.success(
          `Conflict ${blockId + 1} resolved (${resolutionLabel})` +
            (result.value.remainingConflicts > 0
              ? ` — ${result.value.remainingConflicts} remaining`
              : ' — file resolved'),
        );
        // Clear cached diff so it reloads
        setDiffCache((prev) => {
          const next = new Map(prev);
          next.delete(filePath);
          return next;
        });
        // Reload the diff for this file
        loadDiffForFile(filePath);
        await refresh();
      }
    },
    [
      expandedFile,
      selectedFile,
      hasGitContext,
      effectiveThreadId,
      projectModeId,
      refresh,
      loadDiffForFile,
    ],
  );

  const handleStageFile = async (path: string) => {
    if (!hasGitContext) return;
    const result = effectiveThreadId
      ? await api.stageFiles(effectiveThreadId, [path])
      : await api.projectStageFiles(projectModeId!, [path]);
    if (result.isErr()) {
      toast.error(t('review.stageFailed', { path, defaultValue: 'Failed to stage {{path}}' }));
    } else {
      toast.success(t('review.stageSuccess', { path, defaultValue: '{{path}} staged' }));
      await refresh();
    }
  };

  const handleUnstageFile = async (path: string) => {
    if (!hasGitContext) return;
    const result = effectiveThreadId
      ? await api.unstageFiles(effectiveThreadId, [path])
      : await api.projectUnstageFiles(projectModeId!, [path]);
    if (result.isErr()) {
      toast.error(t('review.unstageFailed', { path, defaultValue: 'Failed to unstage {{path}}' }));
    } else {
      toast.success(t('review.unstageSuccess', { path, defaultValue: '{{path}} unstaged' }));
      await refresh();
    }
  };

  // ── Partial (line-level) staging ──
  const [patchStagingInProgress, setPatchStagingInProgress] = useState(false);
  // Track per-file line selection state for indeterminate checkbox: 'all' | 'partial' | 'none'
  const [fileSelectionState, setFileSelectionState] = useState<
    Map<string, 'all' | 'partial' | 'none'>
  >(new Map());
  // Increment to signal ExpandedDiffView to re-select all lines
  const [selectAllSignal, setSelectAllSignal] = useState(0);
  // Increment to signal ExpandedDiffView to deselect all lines
  const [deselectAllSignal, setDeselectAllSignal] = useState(0);

  const handleSelectionStateChange = useCallback(
    (filePath: string, state: 'all' | 'partial' | 'none') => {
      setFileSelectionState((prev) => {
        if (prev.get(filePath) === state) return prev;
        const next = new Map(prev);
        next.set(filePath, state);
        return next;
      });
    },
    [],
  );

  const handleStagePatch = useCallback(
    async (patch: string) => {
      if (!hasGitContext) return;
      setPatchStagingInProgress(true);
      const result = effectiveThreadId
        ? await api.stagePatch(effectiveThreadId, patch)
        : await api.projectStagePatch(projectModeId!, patch);
      setPatchStagingInProgress(false);
      if (result.isErr()) {
        toastError(
          result.error,
          t('review.stageFailed', {
            path: 'selected lines',
            defaultValue: 'Failed to stage {{path}}',
          }),
        );
      } else {
        toast.success(t('review.stageLinesSuccess', { defaultValue: 'Selected lines staged' }));
        await refresh();
      }
    },
    [hasGitContext, effectiveThreadId, projectModeId, refresh, t],
  );

  const handleStageSelected = async () => {
    if (!hasGitContext) return;
    const paths =
      checkedFiles.size > 0
        ? Array.from(checkedFiles).filter((p) => {
            const s = summaries.find((f) => f.path === p);
            return s && !s.staged;
          })
        : summaries.filter((f) => !f.staged).map((f) => f.path);
    if (paths.length === 0) {
      toast.info(t('review.allAlreadyStaged', { defaultValue: 'All files already staged' }));
      return;
    }
    const result = effectiveThreadId
      ? await api.stageFiles(effectiveThreadId, paths)
      : await api.projectStageFiles(projectModeId!, paths);
    if (result.isErr()) {
      toast.error(
        t('review.stageFailed', {
          path: `${paths.length} files`,
          defaultValue: 'Failed to stage {{path}}',
        }),
      );
    } else {
      toast.success(
        t('review.stageSelectedSuccess', {
          count: paths.length,
          defaultValue: '{{count}} file(s) staged',
        }),
      );
      await refresh();
    }
  };

  const handleUnstageAll = async () => {
    if (!hasGitContext) return;
    const paths =
      checkedFiles.size > 0
        ? Array.from(checkedFiles).filter((p) => {
            const s = summaries.find((f) => f.path === p);
            return s && s.staged;
          })
        : summaries.filter((f) => f.staged).map((f) => f.path);
    if (paths.length === 0) {
      toast.info(t('review.noneStaged', { defaultValue: 'No staged files to unstage' }));
      return;
    }
    const result = effectiveThreadId
      ? await api.unstageFiles(effectiveThreadId, paths)
      : await api.projectUnstageFiles(projectModeId!, paths);
    if (result.isErr()) {
      toast.error(
        t('review.unstageFailed', {
          path: `${paths.length} files`,
          defaultValue: 'Failed to unstage {{path}}',
        }),
      );
    } else {
      toast.success(
        t('review.unstageSelectedSuccess', {
          count: paths.length,
          defaultValue: '{{count}} file(s) unstaged',
        }),
      );
      await refresh();
    }
  };

  const handleIgnore = async (pattern: string) => {
    if (!hasGitContext) return;
    const result = effectiveThreadId
      ? await api.addToGitignore(effectiveThreadId, pattern)
      : await api.projectAddToGitignore(projectModeId!, pattern);
    if (result.isErr()) {
      toast.error(t('review.ignoreFailed', { message: result.error.message }));
    } else {
      toast.success(t('review.ignoreSuccess'));
      await refresh();
    }
  };

  const handleAskAgentResolve = async () => {
    // Agent resolve only works with threads, not in project-only mode
    if (!effectiveThreadId) return;

    const target = baseBranch || 'main';
    const prompt = t('review.agentResolvePrompt', { target });
    const { allowedTools, disallowedTools } = deriveToolLists(
      useSettingsStore.getState().toolPermissions,
    );

    const result = await api.sendMessage(effectiveThreadId, prompt, {
      allowedTools,
      disallowedTools,
    });

    if (result.isErr()) {
      toastError(result.error);
      return;
    }

    toast.success(t('review.agentResolveSent'));
    setHasRebaseConflict(false);
  };

  const handleOpenInEditorConflict = () => {
    const worktreePath = useThreadStore.getState().activeThread?.worktreePath;
    if (!worktreePath) return;
    const editor = useSettingsStore.getState().defaultEditor;
    api.openInEditor(worktreePath, editor);
  };

  const getParentFolders = (filePath: string): string[] => {
    const parts = filePath.split('/');
    const folders: string[] = [];
    for (let i = parts.length - 1; i > 0; i--) {
      folders.push('/' + parts.slice(0, i).join('/'));
    }
    return folders;
  };

  const getFileExtension = (filePath: string): string | null => {
    const lastDot = filePath.lastIndexOf('.');
    if (lastDot === -1 || lastDot === filePath.length - 1) return null;
    return filePath.substring(lastDot);
  };

  const handleCopyPath = (path: string, relative: boolean) => {
    const text = relative ? path : basePath ? `${basePath}/${path}` : path;
    navigator.clipboard.writeText(text);
    toast.success(t('review.pathCopied'));
  };

  const handleOpenDirectory = async (relativePath: string, isFile: boolean) => {
    if (!basePath) return;
    const dirRelative = isFile
      ? relativePath.includes('/')
        ? relativePath.slice(0, relativePath.lastIndexOf('/'))
        : ''
      : relativePath;
    const absoluteDir = dirRelative ? `${basePath}/${dirRelative}` : basePath;
    const result = await api.openDirectory(absoluteDir);
    if (result.isErr()) {
      log.error('Failed to open directory', {
        path: absoluteDir,
        error: String(result.error),
      });
      toast.error(t('review.openDirectoryError', 'Failed to open directory'));
    }
  };

  // ── New git operation handlers ──

  const runPull = async (strategy: PullStrategy) => {
    const result = effectiveThreadId
      ? await api.pull(effectiveThreadId, strategy)
      : await api.projectPull(projectModeId!, strategy);
    if (result.isErr()) {
      const msg = result.error.message;
      // When ff-only fails because of a diverged branch, offer merge/rebase
      // instead of just surfacing the raw git hint to the user.
      if (strategy === 'ff-only' && isDivergedBranchesError(msg)) {
        setPullStrategyDialog({ open: true, errorMessage: msg });
        return;
      }
      toast.error(
        t('review.pullFailed', {
          message: msg,
          defaultValue: `Pull failed: ${msg}`,
        }),
      );
    } else {
      toast.success(t('review.pullSuccess', 'Pulled successfully'));
    }
    // Force-refresh git status so unpulled badge clears immediately after pull.
    if (effectiveThreadId) useGitStatusStore.getState().fetchForThread(effectiveThreadId, true);
    else if (projectModeId) useGitStatusStore.getState().fetchProjectStatus(projectModeId, true);
    await refresh();
  };

  const handlePull = async () => {
    if (!hasGitContext || pullInProgress) return;
    setPullInProgress(true);
    try {
      await runPull('ff-only');
    } finally {
      setPullInProgress(false);
    }
  };

  const handlePullStrategyChosen = async (strategy: Exclude<PullStrategy, 'ff-only'>) => {
    setPullStrategyDialog({ open: false, errorMessage: '' });
    if (pullInProgress) return;
    setPullInProgress(true);
    try {
      await runPull(strategy);
    } finally {
      setPullInProgress(false);
    }
  };

  const handleFetchOrigin = async () => {
    if (!hasGitContext || fetchInProgress) return;
    setFetchInProgress(true);
    const result = effectiveThreadId
      ? await api.fetchOrigin(effectiveThreadId)
      : await api.projectFetchOrigin(projectModeId!);
    if (result.isErr()) {
      const msg = result.error.message;
      const isAuthError =
        /auth|token|credential|permission|denied|403|fatal:/i.test(msg) ||
        result.error.type === 'INTERNAL';
      toast.error(
        isAuthError
          ? t('review.fetchAuthFailed', {
              defaultValue:
                'Fetch failed: authentication error. Check your GitHub token in Settings > Profile.',
            })
          : t('review.fetchFailed', {
              message: msg,
              defaultValue: `Fetch failed: ${msg}`,
            }),
      );
    } else {
      toast.success(t('review.fetchSuccess', 'Fetched from origin'));
    }
    setFetchInProgress(false);
    // Force-refresh git status to bypass client-side cooldown so unpulled/unpushed
    // counts update immediately after a manual fetch.
    if (effectiveThreadId) useGitStatusStore.getState().fetchForThread(effectiveThreadId, true);
    else if (projectModeId) useGitStatusStore.getState().fetchProjectStatus(projectModeId, true);
    await refresh();
  };

  const handleStash = async () => {
    if (!hasGitContext || stashInProgress) return;
    setStashInProgress(true);
    const result = effectiveThreadId
      ? await api.stash(effectiveThreadId)
      : await api.projectStash(projectModeId!);
    if (result.isErr()) {
      toast.error(
        t('review.stashFailed', {
          message: result.error.message,
          defaultValue: `Stash failed: ${result.error.message}`,
        }),
      );
    } else {
      toast.success(t('review.stashSuccess', 'Changes stashed'));
    }
    setStashInProgress(false);
    await refresh();
    stash.refreshStashList();
  };

  const handleStashSelected = async () => {
    if (!hasGitContext || stashInProgress) return;
    const paths = checkedFiles.size > 0 ? Array.from(checkedFiles) : summaries.map((f) => f.path);
    if (paths.length === 0) return;
    setStashInProgress(true);
    const result = effectiveThreadId
      ? await api.stash(effectiveThreadId, paths)
      : await api.projectStash(projectModeId!, paths);
    if (result.isErr()) {
      toast.error(
        t('review.stashFailed', {
          message: result.error.message,
          defaultValue: `Stash failed: ${result.error.message}`,
        }),
      );
    } else {
      toast.success(
        t('review.stashSelectedSuccess', {
          count: paths.length,
          defaultValue: '{{count}} file(s) stashed',
        }),
      );
    }
    setStashInProgress(false);
    await refresh();
    stash.refreshStashList();
  };

  const executeResetSoft = async () => {
    if (!hasGitContext || resetInProgress) return;
    setResetInProgress(true);
    const result = effectiveThreadId
      ? await api.resetSoft(effectiveThreadId)
      : await api.projectResetSoft(projectModeId!);
    if (result.isErr()) {
      toast.error(
        t('review.resetSoftFailed', {
          message: result.error.message,
          defaultValue: `Reset failed: ${result.error.message}`,
        }),
      );
    } else {
      toast.success(t('review.resetSoftSuccess', 'Last commit undone'));
    }
    setResetInProgress(false);
    await refresh();
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
        onSuccess={(repoUrl) => {
          setRemoteUrl(repoUrl);
          setPublishDialogOpen(false);
          if (remoteCheckProjectId) {
            useGitStatusStore.getState().fetchProjectStatus(remoteCheckProjectId, true);
          }
          toast.success('Repository ready');
        }}
      />
    </div>
  );
}
