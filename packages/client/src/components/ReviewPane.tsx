import type { FileDiffSummary } from '@funny/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  RefreshCw,
  FileCode,
  FilePlus,
  FileX,
  FileWarning,
  FileCheck2,
  PanelRightClose,
  Search,
  X,
  GitCommit,
  GitMerge,
  Upload,
  GitPullRequest,
  GitPullRequestClosed,
  Sparkles,
  Loader2,
  MoreHorizontal,
  Undo2,
  EyeOff,
  Folder,
  FolderMinus,
  FolderOpen,
  FolderX,
  Copy,
  ClipboardCopy,
  ExternalLink,
  AlertTriangle,
  Plus,
  Minus,
  Archive,
  ArchiveRestore,
  Trash2,
  PenLine,
  RotateCcw,
  ChevronRight,
  GitBranch,
} from 'lucide-react';
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { PullFetchButtons } from '@/components/pull-fetch-buttons';
import { PullStrategyDialog, isDivergedBranchesError } from '@/components/pull-strategy-dialog';
import { PushButton } from '@/components/push-button';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@/components/ui/dropdown-menu';
import { HighlightText } from '@/components/ui/highlight-text';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { TriCheckbox } from '@/components/ui/tri-checkbox';
import { useAutoRefreshDiff } from '@/hooks/use-auto-refresh-diff';
import { useElementLeft } from '@/hooks/use-element-width';
import { api, type PullStrategy } from '@/lib/api';
import { parseDiffOld, parseDiffNew } from '@/lib/diff-parse';
import {
  openFileInExternalEditor,
  openFileInInternalEditor,
  getEditorLabel,
} from '@/lib/editor-utils';
import { FileExtensionIcon } from '@/lib/file-icons';
import { toastError } from '@/lib/toast-error';
import { cn, resolveThreadBranch } from '@/lib/utils';
import { useCommitProgressStore } from '@/stores/commit-progress-store';
import { useDraftStore } from '@/stores/draft-store';
import { useGitStatusStore, useGitStatusForThread } from '@/stores/git-status-store';
import { usePRDetail } from '@/stores/pr-detail-store';
import { useProjectStore } from '@/stores/project-store';
import { useReviewPaneStore } from '@/stores/review-pane-store';
import { useSettingsStore, deriveToolLists } from '@/stores/settings-store';
import { editorLabels } from '@/stores/settings-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore, type ReviewSubTab } from '@/stores/ui-store';

import { CommitHistoryTab } from './CommitHistoryTab';
import { DiffStats } from './DiffStats';
import { buildTreeRows, collectAllFolderPaths } from './FileTree';
import { InlineProgressSteps } from './InlineProgressSteps';
import { PRSummaryCard } from './PRSummaryCard';
import { PublishRepoDialog } from './PublishRepoDialog';
import { PullRequestsTab } from './PullRequestsTab';
import { ExpandedDiffView } from './tool-cards/ExpandedDiffDialog';

const fileStatusIcons: Record<string, typeof FileCode> = {
  added: FilePlus,
  modified: FileCode,
  deleted: FileX,
  renamed: FileCode,
  conflicted: FileWarning,
};

const FILE_ROW_HEIGHT = 24;
const FOLDER_ROW_HEIGHT = 24;
const INDENT_PX = 12;

export function ReviewPane() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const setReviewPaneOpen = useUIStore((s) => s.setReviewPaneOpen);
  const reviewPaneOpen = useUIStore((s) => s.reviewPaneOpen);
  const reviewSubTab = useUIStore((s) => s.reviewSubTab);
  const setReviewSubTabStore = useUIStore((s) => s.setReviewSubTab);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelLeftPx = useElementLeft(panelRef);

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
  const [checkedFiles, setCheckedFiles] = useState<Set<string>>(new Set());
  const { setCommitDraft, clearCommitDraft } = useDraftStore();
  const [commitTitle, setCommitTitleRaw] = useState('');
  const [commitBody, setCommitBodyRaw] = useState('');

  // Use refs to read current values without nesting setState calls
  const commitTitleRef = useRef(commitTitle);
  commitTitleRef.current = commitTitle;
  const commitBodyRef = useRef(commitBody);
  commitBodyRef.current = commitBody;

  // Wrap setters to also persist to draft store
  const draftId = effectiveThreadId || projectModeId;
  const setCommitTitle = useCallback(
    (v: string | ((prev: string) => string)) => {
      setCommitTitleRaw((prev) => {
        const next = typeof v === 'function' ? v(prev) : v;
        if (draftId) {
          setCommitDraft(draftId, next, commitBodyRef.current);
        }
        return next;
      });
    },
    [draftId, setCommitDraft],
  );

  const setCommitBody = useCallback(
    (v: string | ((prev: string) => string)) => {
      setCommitBodyRaw((prev) => {
        const next = typeof v === 'function' ? v(prev) : v;
        if (draftId) {
          setCommitDraft(draftId, commitTitleRef.current, next);
        }
        return next;
      });
    },
    [draftId, setCommitDraft],
  );
  const generatingMsg = useReviewPaneStore((s) =>
    draftId ? (s.generatingCommitMsg[draftId] ?? false) : false,
  );
  const setGeneratingCommitMsg = useReviewPaneStore((s) => s.setGeneratingCommitMsg);
  const generateAbortRef = useRef<AbortController | null>(null);
  const [selectedAction, setSelectedAction] = useState<
    'commit' | 'commit-push' | 'commit-pr' | 'commit-merge' | 'amend'
  >('commit');
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  // New git operations state
  const [pullInProgress, setPullInProgress] = useState(false);
  const [pullStrategyDialog, setPullStrategyDialog] = useState<{
    open: boolean;
    errorMessage: string;
  }>({ open: false, errorMessage: '' });
  const [fetchInProgress, setFetchInProgress] = useState(false);
  const [stashInProgress, setStashInProgress] = useState(false);
  const [stashEntries, setStashEntries] = useState<
    Array<{ index: string; message: string; relativeDate: string }>
  >([]);
  const [stashPopInProgress, setStashPopInProgress] = useState(false);
  const [stashDropInProgress, setStashDropInProgress] = useState<string | null>(null);
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

  // Filter stash entries to only show those from the current branch
  const filteredStashEntries = useMemo(() => {
    if (!currentBranch) return stashEntries;
    return stashEntries.filter((e) => {
      // Stash messages have format: "On <branch>: <message>" or "WIP on <branch>: <message>"
      const match = e.message.match(/^(?:WIP )?[Oo]n ([^:]+):/);
      return match ? match[1] === currentBranch : true;
    });
  }, [stashEntries, currentBranch]);

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
  const [mergeInProgress, setMergeInProgress] = useState(false);
  const [pushInProgress, setPushInProgress] = useState(false);
  const [prInProgress, setPrInProgress] = useState(false);
  const [prDialog, setPrDialog] = useState<{ title: string; body: string } | null>(null);
  const [mergeDialog, setMergeDialog] = useState<{
    targetBranch: string;
    branches: string[];
    loading: boolean;
  } | null>(null);
  const [hasRebaseConflict, setHasRebaseConflict] = useState(false);
  const commitLockRef = useRef(false);

  // Publish repository state — detect repos with no remote origin
  const [remoteUrl, setRemoteUrl] = useState<string | null | undefined>(undefined);
  const [publishDialogOpen, setPublishDialogOpen] = useState(false);

  // Track when a workflow just completed so we can auto-close the pane
  // once the refresh shows a fully-clean branch.
  const justCompletedWorkflowRef = useRef(false);

  // Commit progress (per-thread, persists across thread switches)
  const commitProgressId = effectiveThreadId || projectModeId || '';
  const commitEntry = useCommitProgressStore((s) => s.activeCommits[commitProgressId]);
  const commitInProgress = !!commitEntry;

  // React to server-driven workflow progress (completion, failure, cleanup)
  const prevCommitEntryRef = useRef(commitEntry);
  useEffect(() => {
    const prev = prevCommitEntryRef.current;
    prevCommitEntryRef.current = commitEntry;

    // Workflow finished (entry removed by finishCommit after completed)
    if (prev && !commitEntry) {
      setActionInProgress(null);
      commitLockRef.current = false;
      setPushInProgress(false);
      setMergeInProgress(false);
      setPrInProgress(false);
      justCompletedWorkflowRef.current = true;
      // Refresh diffs and git status
      refresh();
      if (effectiveThreadId && (prev.action === 'commit-merge' || prev.action === 'merge')) {
        // Refresh both active thread and sidebar thread list
        useThreadStore.getState().refreshActiveThread();
        useThreadStore.getState().refreshAllLoadedThreads();
      }
      return;
    }

    if (!commitEntry) return;

    const hasFailed = commitEntry.steps.some((s) => s.status === 'failed');
    const allCompleted = commitEntry.steps.every((s) => s.status === 'completed');

    if (hasFailed) {
      setActionInProgress(null);
      commitLockRef.current = false;
      setPushInProgress(false);
      setMergeInProgress(false);
      setPrInProgress(false);

      // Detect rebase/merge conflicts
      const mergeStep = commitEntry.steps.find((s) => s.id === 'merge' && s.status === 'failed');
      if (mergeStep?.error) {
        const lower = mergeStep.error.toLowerCase();
        if (
          lower.includes('conflict') ||
          lower.includes('rebase failed') ||
          lower.includes('merge failed') ||
          lower.includes('automatic merge failed') ||
          lower.includes('fix conflicts') ||
          lower.includes('could not apply')
        ) {
          setHasRebaseConflict(true);
        }
      }

      // Detect hook failures for toast
      const hookStep = commitEntry.steps.find((s) => s.id === 'hooks' && s.status === 'failed');
      if (hookStep?.error) {
        const failedHook = hookStep.subItems?.find((si) => si.status === 'failed');
        toast.error(
          t('review.hookFailed', 'Pre-commit hook failed: {{hook}}', {
            hook: failedHook?.label || 'unknown',
          }),
        );
      }

      refresh();
    }

    if (allCompleted && prev && !prev.steps.every((s) => s.status === 'completed')) {
      // Just transitioned to all-completed — show success toast
      // Note: push toast is handled in use-ws.ts to avoid duplication
      const action = commitEntry.action;
      if (action === 'push') {
        // handled in use-ws.ts
      } else if (action === 'merge' || action === 'commit-merge') {
        toast.success(
          t('review.mergeSuccess', {
            branch: threadBranch || 'branch',
            target: baseBranch || 'base',
            defaultValue: `Merged "${threadBranch || 'branch'}" into "${baseBranch || 'base'}" successfully`,
          }),
        );
      } else if (action === 'create-pr') {
        toast.success(t('review.prSuccess', 'Pull request created'));
      } else {
        toast.success(t('review.commitSuccess', 'Changes committed successfully'));
      }
    }
  }, [commitEntry]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-close the review pane when the branch becomes fully clean after a workflow
  // (commit-push, push, merge, etc.). This avoids leaving an empty "No changes" pane.
  useEffect(() => {
    if (
      justCompletedWorkflowRef.current &&
      !loading &&
      summaries.length === 0 &&
      stashEntries.length === 0 &&
      unpushedCommitCount === 0 &&
      !hasRebaseConflict
    ) {
      justCompletedWorkflowRef.current = false;
      setReviewPaneOpen(false);
    }
  }, [
    loading,
    summaries.length,
    stashEntries.length,
    unpushedCommitCount,
    hasRebaseConflict,
    setReviewPaneOpen,
  ]);

  // Whether the thread is on a different branch from base (worktree or local mode)
  const isOnDifferentBranch =
    !!effectiveThreadId && !!baseBranch && !!threadBranch && threadBranch !== baseBranch;

  const fileListRef = useRef<HTMLDivElement>(null);

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

  // Lazy load diff content for the selected file
  const loadDiffForFile = useCallback(
    async (filePath: string) => {
      if (!hasGitContext || diffCache.has(filePath)) return;
      const summary = summaries.find((s) => s.path === filePath);
      if (!summary) return;
      const signal = abortRef.current?.signal;
      setLoadingDiff(filePath);
      const result = effectiveThreadId
        ? await api.getFileDiff(effectiveThreadId, filePath, summary.staged, signal)
        : await api.projectFileDiff(projectModeId!, filePath, summary.staged, signal);
      if (result.isOk() && !signal?.aborted) {
        setDiffCache((prev) => new Map(prev).set(filePath, result.value.diff));
      }
      setLoadingDiff((prev) => (prev === filePath ? null : prev));
    },
    [hasGitContext, diffCache, summaries, effectiveThreadId, projectModeId],
  );

  // Fetch full-context diff for the "Show full file" toggle
  const requestFullDiff = async (
    path: string,
  ): Promise<{ oldValue: string; newValue: string; rawDiff?: string } | null> => {
    if (!hasGitContext) return null;
    const summary = summaries.find((s) => s.path === path);
    if (!summary) return null;
    const signal = abortRef.current?.signal;
    const result = effectiveThreadId
      ? await api.getFileDiff(effectiveThreadId, path, summary.staged, signal, 'full')
      : await api.projectFileDiff(projectModeId!, path, summary.staged, signal, 'full');
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
  useEffect(() => {
    // Abort any in-flight git requests from the previous thread/project.
    // This is the key fix for progressive slowdown: without this, each thread
    // switch piles up 5-6 git requests that saturate the server's process pool.
    abortRef.current?.abort();
    // Also abort any in-flight commit message generation so it doesn't write
    // stale results back to local state after the thread switch.
    generateAbortRef.current?.abort();

    setSummaries([]);
    setDiffCache(new Map());
    setSelectedFile(null);
    setCheckedFiles(new Set());
    setFileSearch('');
    setHasRebaseConflict(false);
    setLoadError(false);
    setSelectedAction('commit');

    // Restore commit title/body from draft store
    const draftKey = effectiveThreadId || projectModeId;
    const draft = draftKey ? useDraftStore.getState().drafts[draftKey] : undefined;
    setCommitTitleRaw(draft?.commitTitle ?? '');
    setCommitBodyRaw(draft?.commitBody ?? '');

    // Only fetch data if the pane is visible; otherwise defer until it opens.
    if (reviewPaneOpen) {
      refresh();
    } else {
      needsRefreshRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset+refresh on context change only; refresh/reviewPaneOpen are read but not deps (handled separately)
  }, [gitContextKey, currentBranch]);

  // Check if the project has a remote origin configured (for Publish vs Push UX).
  // Worktrees share the project's git config, so we resolve the underlying
  // project id whether we're in project mode or thread mode.
  const remoteCheckProjectId = projectModeId ?? threadProjectId ?? null;
  useEffect(() => {
    if (!remoteCheckProjectId) {
      setRemoteUrl(undefined);
      return;
    }
    if (gitStatus?.hasRemoteBranch) {
      setRemoteUrl('exists');
      return;
    }
    const controller = new AbortController();
    api.projectGetRemoteUrl(remoteCheckProjectId, controller.signal).then((r) => {
      if (!controller.signal.aborted && r.isOk()) {
        setRemoteUrl(r.value.remoteUrl);
      }
    });
    return () => controller.abort();
  }, [remoteCheckProjectId, gitStatus?.hasRemoteBranch]);

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

  const filteredDiffs = useMemo(() => {
    if (!fileSearch) return summaries;
    const query = fileSearch.toLowerCase();
    return summaries.filter((d) => d.path.toLowerCase().includes(query));
  }, [summaries, fileSearch]);

  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());

  const [expandedSubmodules, setExpandedSubmodules] = useState<Set<string>>(new Set());
  const [submoduleExpansions, setSubmoduleExpansions] = useState<Map<string, FileDiffSummary[]>>(
    new Map(),
  );
  const [submoduleStates, setSubmoduleStates] = useState<
    Map<string, { state: 'loading' | 'error' | 'empty'; message?: string }>
  >(new Map());

  const toggleSubmodule = useCallback(
    async (submodulePath: string) => {
      const currentlyExpanded = expandedSubmodules.has(submodulePath);
      setExpandedSubmodules((prev) => {
        const next = new Set(prev);
        if (currentlyExpanded) next.delete(submodulePath);
        else next.add(submodulePath);
        return next;
      });
      if (currentlyExpanded) return;
      // Fetch only when expanding and we haven't loaded it yet.
      if (submoduleExpansions.has(submodulePath)) return;
      setSubmoduleStates((prev) => {
        const next = new Map(prev);
        next.set(submodulePath, { state: 'loading' });
        return next;
      });
      try {
        const result = effectiveThreadId
          ? await api.getSubmoduleDiffSummary(effectiveThreadId, submodulePath)
          : projectModeId
            ? await api.projectSubmoduleDiffSummary(projectModeId, submodulePath)
            : null;
        if (!result) return;
        if (result.isErr()) {
          setSubmoduleStates((prev) => {
            const next = new Map(prev);
            next.set(submodulePath, {
              state: 'error',
              message: result.error.message,
            });
            return next;
          });
          return;
        }
        const res = result.value;
        if (res.files.length === 0) {
          setSubmoduleStates((prev) => {
            const next = new Map(prev);
            next.set(submodulePath, { state: 'empty' });
            return next;
          });
        } else {
          setSubmoduleExpansions((prev) => {
            const next = new Map(prev);
            next.set(submodulePath, res.files);
            return next;
          });
          setSubmoduleStates((prev) => {
            const next = new Map(prev);
            next.delete(submodulePath);
            return next;
          });
        }
      } catch (e) {
        setSubmoduleStates((prev) => {
          const next = new Map(prev);
          next.set(submodulePath, {
            state: 'error',
            message: e instanceof Error ? e.message : String(e),
          });
          return next;
        });
      }
    },
    [expandedSubmodules, submoduleExpansions, effectiveThreadId, projectModeId],
  );

  const treeRows = useMemo(
    () =>
      buildTreeRows(
        filteredDiffs,
        collapsedFolders,
        submoduleExpansions,
        submoduleStates,
        expandedSubmodules,
      ),
    [filteredDiffs, collapsedFolders, submoduleExpansions, submoduleStates, expandedSubmodules],
  );

  const toggleFolder = useCallback((folderPath: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  }, []);

  const handleCollapseAllFolders = useCallback(() => {
    setCollapsedFolders(collectAllFolderPaths(filteredDiffs));
  }, [filteredDiffs]);

  const handleExpandAllFolders = useCallback(() => {
    setCollapsedFolders(new Set());
  }, []);

  const hasFolders = useMemo(() => treeRows.some((r) => r.kind === 'folder'), [treeRows]);
  const allFoldersCollapsed = useMemo(() => {
    if (!hasFolders) return false;
    return treeRows.every((r) => r.kind !== 'folder' || collapsedFolders.has(r.path));
  }, [treeRows, collapsedFolders, hasFolders]);

  // selectedDiffContent removed — diffs now only shown in expanded modal

  // Only count files that are actually visible (not hidden inside collapsed folders)
  const visibleFiles = useMemo(
    () => treeRows.filter((r): r is Extract<typeof r, { kind: 'file' }> => r.kind === 'file'),
    [treeRows],
  );
  const visiblePaths = useMemo(() => new Set(visibleFiles.map((r) => r.file.path)), [visibleFiles]);
  const checkedCount = [...checkedFiles].filter((p) => visiblePaths.has(p)).length;
  const totalCount = visibleFiles.length;

  const virtualizer = useVirtualizer({
    count: treeRows.length,
    getScrollElement: () => fileListRef.current,
    estimateSize: (index) =>
      treeRows[index]?.kind === 'folder' ? FOLDER_ROW_HEIGHT : FILE_ROW_HEIGHT,
    getItemKey: (index) => {
      const row = treeRows[index];
      if (row.kind === 'folder') return `d:${row.path}`;
      if (row.kind === 'submodule-status') return `s:${row.submodulePath}:${row.state}`;
      return `f:${row.file.path}`;
    },
    overscan: 15,
  });

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

  const handleGenerateCommitMsg = async () => {
    if (!hasGitContext || generatingMsg) return;

    // Capture identity at invocation time so the result always writes to the
    // correct thread/project, even if the user switches away during the await.
    const capturedDraftId = draftId;
    const capturedThreadId = effectiveThreadId;
    const capturedProjectModeId = projectModeId;
    if (!capturedDraftId) return;

    // Abort any previous in-flight generation for this draft
    generateAbortRef.current?.abort();
    const ac = new AbortController();
    generateAbortRef.current = ac;

    setGeneratingCommitMsg(capturedDraftId, true);
    try {
      const result = capturedThreadId
        ? await api.generateCommitMessage(capturedThreadId, true, ac.signal)
        : await api.projectGenerateCommitMessage(capturedProjectModeId!, true, ac.signal);

      if (ac.signal.aborted) return;

      if (result.isOk()) {
        // Always persist to the draft store with the captured ID
        useDraftStore
          .getState()
          .setCommitDraft(capturedDraftId, result.value.title, result.value.body);
        // Only update local state if the user is still on the same thread/project
        const currentDraftId =
          useThreadStore.getState().selectedThreadId ||
          useProjectStore.getState().selectedProjectId;
        if (currentDraftId === capturedDraftId) {
          setCommitTitleRaw(result.value.title);
          setCommitBodyRaw(result.value.body);
        }
      } else if (!ac.signal.aborted) {
        toast.error(t('review.generateFailed', { message: result.error.message }));
      }
    } finally {
      setGeneratingCommitMsg(capturedDraftId, false);
      if (generateAbortRef.current === ac) {
        generateAbortRef.current = null;
      }
    }
  };

  const handleCommitAction = async () => {
    if (!hasGitContext || !commitTitle.trim() || checkedFiles.size === 0 || actionInProgress)
      return;
    if (commitLockRef.current) return;
    commitLockRef.current = true;
    setActionInProgress(selectedAction);

    const toUnstage = summaries
      .filter((f) => f.staged && !checkedFiles.has(f.path))
      .map((f) => f.path);
    const toStage = Array.from(checkedFiles).filter((p) => {
      const s = summaries.find((f) => f.path === p);
      return s && !s.staged;
    });

    const commitMsg = commitBody.trim()
      ? `${commitTitle.trim()}\n\n${commitBody.trim()}`
      : commitTitle.trim();

    // When a thread is active, use the server-side workflow service
    // so operations appear as grouped workflow events (not agent messages)
    if (effectiveThreadId) {
      const params: import('@funny/shared').GitWorkflowRequest = {
        action: selectedAction,
        message: commitMsg,
        filesToStage: toStage,
        filesToUnstage: toUnstage,
        amend: selectedAction === 'amend',
        prTitle: selectedAction === 'commit-pr' ? commitTitle.trim() : undefined,
        prBody: selectedAction === 'commit-pr' ? commitBody.trim() : undefined,
        cleanup: selectedAction === 'commit-merge',
      };

      const result = await api.startWorkflow(effectiveThreadId, params);
      if (result.isErr()) {
        toastError(result.error);
        setActionInProgress(null);
        commitLockRef.current = false;
        return;
      }

      // Progress is now driven by WS events (workflow events in the timeline)
      setCommitTitleRaw('');
      setCommitBodyRaw('');
      if (draftId) clearCommitDraft(draftId);
      return;
    }

    // Project-mode (no thread) — use existing git-workflow-service
    const params: import('@funny/shared').GitWorkflowRequest = {
      action: selectedAction,
      message: commitMsg,
      filesToStage: toStage,
      filesToUnstage: toUnstage,
      amend: selectedAction === 'amend',
      prTitle: selectedAction === 'commit-pr' ? commitTitle.trim() : undefined,
      prBody: selectedAction === 'commit-pr' ? commitBody.trim() : undefined,
      cleanup: selectedAction === 'commit-merge',
    };

    const result = await api.projectStartWorkflow(projectModeId!, params);

    if (result.isErr()) {
      toastError(result.error);
      setActionInProgress(null);
      commitLockRef.current = false;
      return;
    }

    // Clear draft on successful submission — progress is now driven by WS
    setCommitTitleRaw('');
    setCommitBodyRaw('');
    if (draftId) clearCommitDraft(draftId);
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

  const handlePushOnly = async () => {
    if (!hasGitContext || pushInProgress) return;
    setPushInProgress(true);

    const result = effectiveThreadId
      ? await api.startWorkflow(effectiveThreadId, { action: 'push' })
      : await api.projectStartWorkflow(projectModeId!, { action: 'push' });

    if (result.isErr()) {
      toastError(result.error);
      setPushInProgress(false);
    }
    // pushInProgress will be cleared by the useEffect watching commitEntry
  };

  const openMergeDialog = async () => {
    const pid = threadProjectId ?? selectedProjectId ?? '';
    if (!pid) return;

    setMergeDialog({ targetBranch: baseBranch || '', branches: [], loading: true });

    const result = await api.listBranches(pid);
    if (result.isOk()) {
      const data = result.value;
      const branches = data.branches.filter((b) => b !== currentBranch);
      const defaultTarget =
        baseBranch && branches.includes(baseBranch)
          ? baseBranch
          : data.defaultBranch && branches.includes(data.defaultBranch)
            ? data.defaultBranch
            : branches[0] || '';
      setMergeDialog((prev) =>
        prev ? { ...prev, targetBranch: defaultTarget, branches, loading: false } : null,
      );
    } else {
      setMergeDialog(null);
      toastError(result.error);
    }
  };

  const handleMergeWithTarget = async () => {
    if (!hasGitContext || mergeInProgress || !mergeDialog?.targetBranch) return;
    setMergeInProgress(true);

    const params: import('@funny/shared').GitWorkflowRequest = {
      action: 'merge',
      cleanup: true,
      targetBranch: mergeDialog.targetBranch,
    };

    const result = effectiveThreadId
      ? await api.startWorkflow(effectiveThreadId, params)
      : await api.projectStartWorkflow(projectModeId!, params);

    if (result.isErr()) {
      toastError(result.error);
      setMergeInProgress(false);
    }
    setMergeDialog(null);
    // mergeInProgress will be cleared by the useEffect watching commitEntry
  };

  const handleCreatePROnly = async () => {
    if (!hasGitContext || prInProgress || !prDialog) return;
    setPrInProgress(true);

    const result = effectiveThreadId
      ? await api.startWorkflow(effectiveThreadId, {
          action: 'create-pr',
          prTitle: prDialog.title.trim(),
          prBody: prDialog.body.trim(),
        })
      : await api.projectStartWorkflow(projectModeId!, {
          action: 'create-pr',
          prTitle: prDialog.title.trim(),
          prBody: prDialog.body.trim(),
        });

    if (result.isErr()) {
      toastError(result.error);
      setPrInProgress(false);
      return;
    }
    setPrDialog(null);
    // prInProgress will be cleared by the useEffect watching commitEntry
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
    refreshStashList();
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
    refreshStashList();
  };

  const handleStashPop = async () => {
    if (!hasGitContext || stashPopInProgress) return;
    setStashPopInProgress(true);
    const result = effectiveThreadId
      ? await api.stashPop(effectiveThreadId)
      : await api.projectStashPop(projectModeId!);
    if (result.isErr()) {
      toast.error(
        t('review.stashPopFailed', {
          message: result.error.message,
          defaultValue: `Stash pop failed: ${result.error.message}`,
        }),
      );
    } else {
      toast.success(t('review.stashPopSuccess', 'Stash applied'));
    }
    setStashPopInProgress(false);
    await refresh();
    refreshStashList();
  };

  const executeStashDrop = async (stashIndex: string) => {
    if (!hasGitContext || stashDropInProgress) return;
    setStashDropInProgress(stashIndex);
    const result = effectiveThreadId
      ? await api.stashDrop(effectiveThreadId, stashIndex)
      : await api.projectStashDrop(projectModeId!, stashIndex);
    if (result.isErr()) {
      toast.error(
        t('review.stashDropFailed', {
          message: result.error.message,
          defaultValue: `Drop stash failed: ${result.error.message}`,
        }),
      );
    } else {
      toast.success(t('review.stashDropSuccess', 'Stash discarded'));
    }
    setStashDropInProgress(null);
    setExpandedStashIndex(null);
    setStashFiles([]);
    await refresh();
    refreshStashList();
  };

  const refreshStashList = async () => {
    if (!hasGitContext) return;
    const signal = abortRef.current?.signal;
    const result = effectiveThreadId
      ? await api.stashList(effectiveThreadId, signal)
      : await api.projectStashList(projectModeId!, signal);
    if (result.isOk() && !signal?.aborted) {
      setStashEntries(result.value.entries);
    }
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

  // Load stash list lazily — only when the stash tab is active and visible.
  // Previously loaded on every context change even if only the Changes tab
  // was active, wasting a git request that saturated the process pool.
  useEffect(() => {
    if (reviewPaneOpen && reviewSubTab === 'stash') {
      refreshStashList();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshStashList is a non-memoized function; only trigger on context/visibility/tab change
  }, [gitContextKey, reviewPaneOpen, reviewSubTab]);

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

  // ── Stash tab: expanded stash entry to show its files ──
  const [expandedStashIndex, setExpandedStashIndex] = useState<string | null>(null);
  const [stashFiles, setStashFiles] = useState<
    Array<{ path: string; additions: number; deletions: number }>
  >([]);
  const [stashFilesLoading, setStashFilesLoading] = useState(false);

  const loadStashFiles = useCallback(
    async (index: string) => {
      if (!hasGitContext) return;
      setStashFilesLoading(true);
      const result = effectiveThreadId
        ? await api.stashShow(effectiveThreadId, index)
        : await api.projectStashShow(projectModeId!, index);
      if (result.isOk()) {
        setStashFiles(result.value.files);
      }
      setStashFilesLoading(false);
    },
    [hasGitContext, effectiveThreadId, projectModeId],
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
    <div ref={panelRef} className="flex h-full flex-col">
      {/* Diff viewer overlay — portal to body so it escapes contain:strict ancestors */}
      {expandedFile &&
        panelLeftPx > 0 &&
        createPortal(
          <div
            className="fixed bottom-0 left-0 top-0 z-40 bg-background"
            style={{ width: `${panelLeftPx}px` }}
            data-testid="expanded-diff-overlay"
          >
            <ExpandedDiffView
              filePath={expandedSummary?.path || ''}
              oldValue={expandedDiffContent ? parseDiffOld(expandedDiffContent) : ''}
              newValue={expandedDiffContent ? parseDiffNew(expandedDiffContent) : ''}
              icon={ExpandedIcon}
              loading={loadingDiff === expandedFile}
              rawDiff={expandedDiffContent}
              files={summaries}
              onFileSelect={handleExpandedFileSelect}
              diffCache={diffCache}
              onClose={handleExpandedClose}
              prReviewThreads={prThreads}
              onRequestFullDiff={requestFullDiff}
              onResolveConflict={handleResolveConflict}
              selectable
              onStagePatch={handleStagePatch}
              stagingInProgress={patchStagingInProgress}
              onSelectionStateChange={handleSelectionStateChange}
              selectAllSignal={selectAllSignal}
              deselectAllSignal={deselectAllSignal}
            />
          </div>,
          document.body,
        )}
      {/* Normal ReviewPane content — untouched by the overlay */}
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
              <div className="flex items-center gap-1 border-b border-sidebar-border px-2 py-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={refresh}
                      className="text-muted-foreground"
                      data-testid="review-refresh"
                    >
                      <RefreshCw className={cn('icon-base', loading && 'animate-spin')} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{t('review.refresh')}</TooltipContent>
                </Tooltip>
                <PullFetchButtons
                  onPull={handlePull}
                  onFetch={handleFetchOrigin}
                  pullInProgress={pullInProgress}
                  fetchInProgress={fetchInProgress}
                  unpulledCommitCount={gitStatus?.unpulledCommitCount ?? 0}
                  testIdPrefix="review"
                />
                {remoteUrl === null ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setPublishDialogOpen(true)}
                        className="relative text-muted-foreground"
                        data-testid="review-publish-toolbar"
                      >
                        <Upload className="icon-base" />
                        {unpushedCommitCount > 0 && (
                          <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-blue-500 px-0.5 text-[9px] font-bold leading-none text-white">
                            {unpushedCommitCount}
                          </span>
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {unpushedCommitCount > 0
                        ? t('review.publishWithCommits', {
                            count: unpushedCommitCount,
                            defaultValue: `Publish repository (${unpushedCommitCount} commit(s) to push)`,
                          })
                        : t('review.publishRepo', 'Publish repository')}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <PushButton
                    onPush={handlePushOnly}
                    pushInProgress={pushInProgress}
                    unpushedCommitCount={unpushedCommitCount}
                    testIdPrefix="review"
                  />
                )}
                {!!threadBranch && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={openMergeDialog}
                        disabled={mergeInProgress || summaries.length > 0}
                        className="text-muted-foreground"
                        data-testid="review-merge-toolbar"
                      >
                        <GitMerge className={cn('icon-base', mergeInProgress && 'animate-pulse')} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {summaries.length > 0
                        ? t('review.commitFirst', 'Commit changes before merging')
                        : t('review.mergeIntoBranch', {
                            target: baseBranch || 'base',
                            defaultValue: `Merge into branch`,
                          })}
                    </TooltipContent>
                  </Tooltip>
                )}
                {isOnDifferentBranch && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      {gitStatus?.prNumber ? (
                        (() => {
                          const prState = gitStatus.prState ?? 'OPEN';
                          const PrIcon =
                            prState === 'MERGED'
                              ? GitMerge
                              : prState === 'CLOSED'
                                ? GitPullRequestClosed
                                : GitPullRequest;
                          const prIconColor =
                            prState === 'MERGED'
                              ? 'text-purple-500'
                              : prState === 'CLOSED'
                                ? 'text-red-500'
                                : 'text-green-500';
                          return (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => window.open(gitStatus.prUrl, '_blank')}
                              className="text-muted-foreground"
                              data-testid="review-view-pr-toolbar"
                            >
                              <PrIcon className={`icon-base ${prIconColor}`} />
                            </Button>
                          );
                        })()
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => setPrDialog({ title: threadBranch || '', body: '' })}
                          disabled={!!isAgentRunning}
                          className="text-muted-foreground"
                          data-testid="review-create-pr-toolbar"
                        >
                          <GitPullRequest className="icon-base" />
                        </Button>
                      )}
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {gitStatus?.prNumber
                        ? t('review.viewPR', {
                            number: gitStatus.prNumber,
                            defaultValue: `View PR #${gitStatus.prNumber}`,
                          })
                        : isAgentRunning
                          ? t('review.agentRunningTooltip')
                          : t('review.createPRTooltip', {
                              branch: threadBranch,
                              target: baseBranch || 'base',
                            })}
                    </TooltipContent>
                  </Tooltip>
                )}
                {summaries.length > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={handleStageSelected}
                        disabled={!!actionInProgress || !!isAgentRunning}
                        className="text-muted-foreground"
                        data-testid="review-stage-selected"
                      >
                        <Plus className="icon-base" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {isAgentRunning
                        ? t('review.agentRunningTooltip')
                        : checkedFiles.size > 0
                          ? t('review.stageSelected', { defaultValue: 'Stage selected' })
                          : t('review.stageAll', { defaultValue: 'Stage all' })}
                    </TooltipContent>
                  </Tooltip>
                )}
                {summaries.some((f) => f.staged) && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={handleUnstageAll}
                        disabled={!!actionInProgress || !!isAgentRunning}
                        className="text-muted-foreground"
                        data-testid="review-unstage-selected"
                      >
                        <Minus className="icon-base" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {isAgentRunning
                        ? t('review.agentRunningTooltip')
                        : checkedFiles.size > 0
                          ? t('review.unstageSelected', { defaultValue: 'Unstage selected' })
                          : t('review.unstageAll', { defaultValue: 'Unstage all' })}
                    </TooltipContent>
                  </Tooltip>
                )}
                {summaries.length > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={handleStashSelected}
                        disabled={!!actionInProgress || !!isAgentRunning || stashInProgress}
                        className="text-muted-foreground"
                        data-testid="review-stash-selected"
                      >
                        <Archive className={cn('icon-base', stashInProgress && 'animate-pulse')} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {isAgentRunning
                        ? t('review.agentRunningTooltip')
                        : checkedFiles.size > 0
                          ? t('review.stashSelected', { defaultValue: 'Stash selected' })
                          : t('review.stashAll', { defaultValue: 'Stash all' })}
                    </TooltipContent>
                  </Tooltip>
                )}
                {summaries.length > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={handleDiscardAll}
                        disabled={!!actionInProgress || !!isAgentRunning}
                        className="text-muted-foreground"
                        data-testid="review-discard-all"
                      >
                        <Undo2 className="icon-base" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {isAgentRunning
                        ? t('review.agentRunningTooltip')
                        : t('review.discard', 'Discard')}
                    </TooltipContent>
                  </Tooltip>
                )}
                {summaries.length > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={handleIgnoreFiles}
                        disabled={!!actionInProgress}
                        className="text-muted-foreground"
                        data-testid="review-ignore-files"
                      >
                        <EyeOff className="icon-base" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {checkedFiles.size > 0
                        ? `Add ${checkedFiles.size} file(s) to .gitignore`
                        : 'Add all to .gitignore'}
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>

              {/* File search */}
              {summaries.length > 0 && (
                <div className="border-b border-sidebar-border px-2 py-2">
                  <div className="relative">
                    <Search className="icon-sm pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      type="text"
                      placeholder={t('review.searchFiles', 'Filter files\u2026')}
                      aria-label={t('review.searchFiles', 'Filter files')}
                      data-testid="review-file-filter"
                      value={fileSearch}
                      onChange={(e) => setFileSearch(e.target.value)}
                      className="h-7 pl-7 pr-7 text-xs md:text-xs"
                    />
                    {fileSearch && (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => setFileSearch('')}
                        aria-label={t('review.clearSearch', 'Clear search')}
                        data-testid="review-file-filter-clear"
                        className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground"
                      >
                        <X className="icon-xs" />
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {/* Select all / count */}
              {summaries.length > 0 && (
                <div className="flex h-8 items-center gap-1.5 border-b border-sidebar-border py-1.5 pl-2 pr-2">
                  <TriCheckbox
                    state={
                      checkedCount === totalCount && totalCount > 0
                        ? 'checked'
                        : checkedCount > 0
                          ? 'indeterminate'
                          : 'unchecked'
                    }
                    onToggle={toggleAll}
                    aria-label={t('review.selectAll', 'Select all files')}
                    data-testid="review-select-all"
                  />
                  <span className="text-xs text-muted-foreground">
                    {checkedCount}/{totalCount} {t('review.selected', 'selected')}
                  </span>
                  {hasFolders && (
                    <div className="ml-auto flex items-center gap-0.5">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={handleCollapseAllFolders}
                            disabled={allFoldersCollapsed}
                            data-testid="review-collapse-all"
                            className="text-muted-foreground"
                          >
                            <FolderMinus className="icon-xs" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          {t('common.collapseAll', 'Collapse all folders')}
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={handleExpandAllFolders}
                            disabled={collapsedFolders.size === 0}
                            data-testid="review-expand-all"
                            className="text-muted-foreground"
                          >
                            <FolderOpen className="icon-xs" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          {t('common.expandAll', 'Expand all folders')}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  )}
                </div>
              )}

              {/* File list (virtualized) — wrapper ensures flex-1 so commit area stays pinned to bottom */}
              <div ref={fileListRef} className="min-h-0 flex-1 overflow-auto">
                {loading && summaries.length === 0 ? (
                  <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                    <Loader2 className="icon-sm animate-spin" />
                    {t('review.loading', 'Loading changes\u2026')}
                  </div>
                ) : loadError ? (
                  <div className="flex flex-col items-center gap-2 p-4 text-xs text-muted-foreground">
                    <AlertTriangle className="icon-base text-status-error" />
                    <p>{t('review.loadFailed', 'Failed to load changes')}</p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={refresh}
                      className="mt-1 gap-1.5"
                      data-testid="review-retry"
                    >
                      <RotateCcw className="icon-xs" />
                      {t('common.retry', 'Retry')}
                    </Button>
                  </div>
                ) : summaries.length === 0 && !loading ? (
                  <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 p-4 text-muted-foreground">
                    <FileCheck2 className="h-8 w-8 opacity-40" />
                    <p className="text-xs">{t('review.noChanges')}</p>
                  </div>
                ) : filteredDiffs.length === 0 && !loading ? (
                  <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 p-4 text-muted-foreground">
                    <Search className="h-8 w-8 opacity-40" />
                    <p className="text-xs">{t('review.noMatchingFiles', 'No matching files')}</p>
                  </div>
                ) : (
                  <div className={cn(loading && 'pointer-events-none')}>
                    <div
                      style={{
                        height: `${virtualizer.getTotalSize()}px`,
                        width: '100%',
                        position: 'relative',
                      }}
                    >
                      {virtualizer.getVirtualItems().map((virtualRow) => {
                        const row = treeRows[virtualRow.index];
                        const paddingLeft = `${8 + row.depth * INDENT_PX}px`;

                        if (row.kind === 'submodule-status') {
                          const label =
                            row.state === 'loading'
                              ? t('review.submoduleLoading', {
                                  defaultValue: 'Loading submodule files…',
                                })
                              : row.state === 'error'
                                ? (row.message ??
                                  t('review.submoduleError', {
                                    defaultValue: 'Failed to load submodule',
                                  }))
                                : t('review.submoduleEmpty', {
                                    defaultValue: 'No changes inside submodule',
                                  });
                          return (
                            <div
                              key={`submodule-status-${row.submodulePath}-${row.state}`}
                              className="flex items-center gap-1.5 text-xs italic text-muted-foreground/80"
                              style={{
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: '100%',
                                height: `${virtualRow.size}px`,
                                transform: `translateY(${virtualRow.start}px)`,
                                paddingLeft,
                              }}
                              data-testid={`review-submodule-status-${row.submodulePath}`}
                            >
                              <span className="truncate">{label}</span>
                            </div>
                          );
                        }

                        if (row.kind === 'folder') {
                          const isCollapsed = collapsedFolders.has(row.path);
                          return (
                            <div
                              key={`folder-${row.path}`}
                              className="group flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted-foreground hover:bg-sidebar-accent/50"
                              style={{
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: '100%',
                                height: `${virtualRow.size}px`,
                                transform: `translateY(${virtualRow.start}px)`,
                                paddingLeft,
                              }}
                              onClick={() => toggleFolder(row.path)}
                              data-testid={`review-folder-${row.path}`}
                            >
                              <ChevronRight
                                className={cn(
                                  'icon-sm flex-shrink-0 transition-transform',
                                  !isCollapsed && 'rotate-90',
                                )}
                              />
                              {isCollapsed ? (
                                <Folder className="icon-base flex-shrink-0 text-muted-foreground/70" />
                              ) : (
                                <FolderOpen className="icon-base flex-shrink-0 text-muted-foreground/70" />
                              )}
                              <HighlightText
                                text={row.label}
                                query={fileSearch}
                                className="flex-1 truncate font-mono-explorer text-xs"
                              />
                              <DiffStats
                                linesAdded={row.additions}
                                linesDeleted={row.deletions}
                                size="xs"
                              />
                              {/* Spacer to align with file rows' status letter */}
                              <span className="invisible flex-shrink-0 text-xs font-medium">M</span>
                              <DropdownMenu
                                onOpenChange={(open) => {
                                  if (!open) dropdownCloseRef.current = Date.now();
                                }}
                              >
                                <DropdownMenuTrigger asChild>
                                  <button
                                    onClick={(e) => e.stopPropagation()}
                                    onPointerDown={(e) => e.stopPropagation()}
                                    aria-label={t('review.moreActions', 'More actions')}
                                    className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-all hover:bg-sidebar-accent hover:text-foreground group-hover:opacity-100 data-[state=open]:opacity-100"
                                    data-testid={`review-folder-menu-${row.path}`}
                                  >
                                    <MoreHorizontal className="icon-sm" />
                                  </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent
                                  align="end"
                                  className="min-w-[220px]"
                                  onCloseAutoFocus={(e) => e.preventDefault()}
                                >
                                  <DropdownMenuItem
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleIgnore(row.path);
                                    }}
                                    data-testid={`review-folder-ignore-${row.path}`}
                                  >
                                    <FolderX />
                                    {t('review.ignoreFolder')}
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          );
                        }

                        const f = row.file;
                        const isChecked = checkedFiles.has(f.path);
                        const lineSelState = fileSelectionState.get(f.path);
                        const isPartial = isChecked && lineSelState === 'partial';
                        return (
                          <div
                            key={f.path}
                            style={{
                              position: 'absolute',
                              top: 0,
                              left: 0,
                              width: '100%',
                              height: `${virtualRow.size}px`,
                              transform: `translateY(${virtualRow.start}px)`,
                              paddingLeft,
                            }}
                            className={cn(
                              'group flex items-center gap-1.5 text-xs cursor-pointer',
                              selectedFile === f.path
                                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                                : 'hover:bg-sidebar-accent/50 text-muted-foreground',
                            )}
                            onClick={() => {
                              if (Date.now() - dropdownCloseRef.current < 400) return;
                              setSelectedFile(f.path);
                              setExpandedFile(f.path);
                            }}
                          >
                            <TriCheckbox
                              state={
                                isPartial ? 'indeterminate' : isChecked ? 'checked' : 'unchecked'
                              }
                              onToggle={(e) => {
                                e.stopPropagation();
                                // If partial or unchecked → check and re-select all lines
                                if (isPartial || !isChecked) {
                                  if (!isChecked) toggleFile(f.path);
                                  // Signal ExpandedDiffView to re-select all lines
                                  if (expandedFile === f.path) {
                                    setSelectAllSignal((s) => s + 1);
                                  }
                                  // Clear the partial state immediately
                                  setFileSelectionState((prev) => {
                                    const next = new Map(prev);
                                    next.set(f.path, 'all');
                                    return next;
                                  });
                                } else {
                                  toggleFile(f.path);
                                  // Signal ExpandedDiffView to deselect all lines
                                  if (expandedFile === f.path) {
                                    setDeselectAllSignal((s) => s + 1);
                                  }
                                  setFileSelectionState((prev) => {
                                    const next = new Map(prev);
                                    next.set(f.path, 'none');
                                    return next;
                                  });
                                }
                              }}
                              aria-label={t('review.selectFile', {
                                file: f.path,
                                defaultValue: `Select ${f.path}`,
                              })}
                              data-testid={`review-file-checkbox-${f.path}`}
                            />
                            {f.kind === 'submodule' && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleSubmodule(f.path);
                                }}
                                aria-label={
                                  expandedSubmodules.has(f.path)
                                    ? t('review.collapseSubmodule', {
                                        defaultValue: 'Collapse submodule',
                                      })
                                    : t('review.expandSubmodule', {
                                        defaultValue: 'Expand submodule',
                                      })
                                }
                                className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                                data-testid={`review-submodule-toggle-${f.path}`}
                              >
                                <ChevronRight
                                  className={cn(
                                    'icon-sm transition-transform',
                                    expandedSubmodules.has(f.path) && 'rotate-90',
                                  )}
                                />
                              </button>
                            )}
                            {f.kind === 'submodule' ? (
                              <GitBranch
                                className="icon-base flex-shrink-0 text-purple-500 dark:text-purple-400"
                                data-testid={`review-submodule-icon-${f.path}`}
                              />
                            ) : (
                              <FileExtensionIcon
                                filePath={f.path}
                                className="icon-base flex-shrink-0 text-muted-foreground/80"
                              />
                            )}
                            <HighlightText
                              text={f.path.split('/').pop() || f.path}
                              query={fileSearch}
                              className="flex-1 truncate font-mono-explorer text-xs"
                            />
                            {f.kind === 'submodule' && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span
                                    className="flex-shrink-0 rounded-sm border border-purple-500/40 bg-purple-500/10 px-1 text-[10px] uppercase tracking-wide text-purple-600 dark:text-purple-300"
                                    data-testid={`review-submodule-badge-${f.path}`}
                                  >
                                    {f.nestedDirty && f.nestedDirty.dirtyFileCount > 0
                                      ? t('review.submoduleDirtyCount', {
                                          count: f.nestedDirty.dirtyFileCount,
                                          defaultValue: 'submodule · {{count}}',
                                        })
                                      : t('review.submodule', { defaultValue: 'submodule' })}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="max-w-xs text-xs">
                                  <div className="font-medium">
                                    {t('review.submoduleTooltip', {
                                      defaultValue: 'Nested git repository (gitlink)',
                                    })}
                                  </div>
                                  {f.nestedDirty && (
                                    <div className="mt-1 space-y-0.5 font-mono">
                                      {f.nestedDirty.pointerMoved && (
                                        <div>
                                          {t('review.submodulePointerMoved', {
                                            defaultValue:
                                              'Gitlink pointer moved (parent-visible change).',
                                          })}
                                        </div>
                                      )}
                                      <div>
                                        {t('review.submoduleDirtyLine', {
                                          count: f.nestedDirty.dirtyFileCount,
                                          defaultValue: '{{count}} file(s) dirty inside',
                                        })}
                                      </div>
                                      {(f.nestedDirty.linesAdded > 0 ||
                                        f.nestedDirty.linesDeleted > 0) && (
                                        <div>
                                          <span className="text-diff-added">
                                            +{f.nestedDirty.linesAdded}
                                          </span>{' '}
                                          <span className="text-diff-removed">
                                            -{f.nestedDirty.linesDeleted}
                                          </span>{' '}
                                          <span className="text-muted-foreground">
                                            {t('review.submoduleLines', { defaultValue: 'lines' })}
                                          </span>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                  <div className="mt-1 text-muted-foreground">
                                    {t('review.submoduleExpandHint', {
                                      defaultValue: 'Click the arrow to expand inner files.',
                                    })}
                                  </div>
                                </TooltipContent>
                              </Tooltip>
                            )}
                            <DiffStats
                              linesAdded={
                                f.kind === 'submodule' && f.nestedDirty
                                  ? f.nestedDirty.linesAdded
                                  : (f.additions ?? 0)
                              }
                              linesDeleted={
                                f.kind === 'submodule' && f.nestedDirty
                                  ? f.nestedDirty.linesDeleted
                                  : (f.deletions ?? 0)
                              }
                              size="xs"
                            />
                            <span
                              className="flex-shrink-0 text-xs font-medium"
                              style={{
                                color:
                                  f.status === 'conflicted'
                                    ? 'hsl(0 72% 51%)'
                                    : f.status === 'added'
                                      ? 'hsl(142 40% 45%)'
                                      : f.status === 'modified'
                                        ? 'hsl(30 90% 55%)'
                                        : f.status === 'deleted'
                                          ? 'hsl(0 45% 55%)'
                                          : 'hsl(200 80% 60%)',
                              }}
                            >
                              {f.status === 'conflicted'
                                ? 'C'
                                : f.status === 'added'
                                  ? 'A'
                                  : f.status === 'modified'
                                    ? 'M'
                                    : f.status === 'deleted'
                                      ? 'D'
                                      : 'R'}
                            </span>
                            <DropdownMenu
                              onOpenChange={(open) => {
                                if (!open) dropdownCloseRef.current = Date.now();
                              }}
                            >
                              <DropdownMenuTrigger asChild>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                  }}
                                  onPointerDown={(e) => {
                                    e.stopPropagation();
                                  }}
                                  aria-label={t('review.moreActions', 'More actions')}
                                  className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-all hover:bg-sidebar-accent hover:text-foreground group-hover:opacity-100 data-[state=open]:opacity-100"
                                >
                                  <MoreHorizontal className="icon-sm" />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent
                                align="end"
                                className="min-w-[220px]"
                                onCloseAutoFocus={(e) => e.preventDefault()}
                              >
                                <DropdownMenuItem
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const fullPath = basePath ? `${basePath}/${f.path}` : f.path;
                                    openFileInExternalEditor(fullPath);
                                  }}
                                >
                                  <ExternalLink />
                                  {t('review.openInEditor', { editor: getEditorLabel() })}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const fullPath = basePath ? `${basePath}/${f.path}` : f.path;
                                    openFileInInternalEditor(fullPath);
                                  }}
                                  data-testid={`review-open-internal-editor-${f.path}`}
                                >
                                  <FileCode />
                                  {t('review.openInInternalEditor')}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                {f.staged ? (
                                  <DropdownMenuItem
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleUnstageFile(f.path);
                                    }}
                                    data-testid={`review-unstage-file-${f.path}`}
                                  >
                                    <ArchiveRestore />
                                    {t('review.unstageFile', { defaultValue: 'Unstage file' })}
                                  </DropdownMenuItem>
                                ) : (
                                  <DropdownMenuItem
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleStageFile(f.path);
                                    }}
                                    data-testid={`review-stage-file-${f.path}`}
                                  >
                                    <Archive />
                                    {t('review.stageFile', { defaultValue: 'Stage file' })}
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuItem
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleRevertFile(f.path);
                                  }}
                                  className="text-destructive focus:text-destructive"
                                >
                                  <Undo2 />
                                  {t('review.discardChanges')}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleIgnore(f.path);
                                  }}
                                >
                                  <EyeOff />
                                  {t('review.ignoreFile')}
                                </DropdownMenuItem>
                                {(() => {
                                  const folders = getParentFolders(f.path);
                                  if (folders.length === 0) return null;
                                  if (folders.length === 1) {
                                    return (
                                      <DropdownMenuItem
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleIgnore(folders[0]);
                                        }}
                                      >
                                        <FolderX />
                                        {t('review.ignoreFolder')}
                                      </DropdownMenuItem>
                                    );
                                  }
                                  return (
                                    <DropdownMenuSub>
                                      <DropdownMenuSubTrigger
                                        onClick={(e) => e.stopPropagation()}
                                        onPointerDown={(e) => e.stopPropagation()}
                                      >
                                        <FolderX />
                                        {t('review.ignoreFolder')}
                                      </DropdownMenuSubTrigger>
                                      <DropdownMenuSubContent
                                        onClick={(e) => e.stopPropagation()}
                                        onPointerDown={(e) => e.stopPropagation()}
                                      >
                                        {folders.map((folder) => (
                                          <DropdownMenuItem
                                            key={folder}
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              handleIgnore(folder);
                                            }}
                                          >
                                            {folder}
                                          </DropdownMenuItem>
                                        ))}
                                      </DropdownMenuSubContent>
                                    </DropdownMenuSub>
                                  );
                                })()}
                                {(() => {
                                  const ext = getFileExtension(f.path);
                                  if (!ext) return null;
                                  return (
                                    <DropdownMenuItem
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleIgnore(`*${ext}`);
                                      }}
                                    >
                                      <EyeOff />
                                      {t('review.ignoreExtension', { ext })}
                                    </DropdownMenuItem>
                                  );
                                })()}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleCopyPath(f.path, false);
                                  }}
                                >
                                  <Copy />
                                  {t('review.copyFilePath')}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleCopyPath(f.path, true);
                                  }}
                                >
                                  <ClipboardCopy />
                                  {t('review.copyRelativePath')}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* Commit / workflow progress */}
              {commitInProgress && (
                <div className="flex-shrink-0 space-y-2 border-t border-sidebar-border p-2">
                  <p className="text-xs font-medium text-foreground">{commitEntry.title}</p>
                  <InlineProgressSteps steps={commitEntry.steps} />
                  {(() => {
                    const hasFailed = commitEntry.steps.some((s) => s.status === 'failed');
                    const isRunning = commitEntry.steps.some((s) => s.status === 'running');
                    const isFinished =
                      !isRunning &&
                      (commitEntry.steps.every(
                        (s) => s.status === 'completed' || s.status === 'failed',
                      ) ||
                        hasFailed);
                    if (isFinished && hasFailed) {
                      return (
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full"
                          onClick={() => {
                            useCommitProgressStore.getState().finishCommit(commitProgressId);
                            setActionInProgress(null);
                          }}
                        >
                          {t('review.progress.dismiss', 'Dismiss')}
                        </Button>
                      );
                    }
                    return null;
                  })()}
                </div>
              )}
              {summaries.length > 0 && !commitInProgress && (
                <div className="flex-shrink-0 space-y-1.5 border-t border-sidebar-border p-2">
                  <Input
                    type="text"
                    placeholder={t('review.commitTitle')}
                    aria-label={t('review.commitTitle', 'Commit title')}
                    data-testid="review-commit-title"
                    value={commitTitle}
                    onChange={(e) => setCommitTitle(e.target.value)}
                    disabled={!!actionInProgress || generatingMsg}
                    className="h-auto px-2 py-1.5 text-xs"
                  />
                  <div className="rounded-md border border-input bg-background focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/50">
                    <textarea
                      className="w-full resize-none bg-transparent px-2 py-1.5 text-xs placeholder:text-muted-foreground focus-visible:outline-none"
                      rows={7}
                      aria-label={t('review.commitBody', 'Commit body')}
                      data-testid="review-commit-body"
                      placeholder={t('review.commitBody')}
                      value={commitBody}
                      onChange={(e) => setCommitBody(e.target.value)}
                      disabled={!!actionInProgress || generatingMsg}
                    />
                    <div className="flex items-center px-1.5 py-1">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={handleGenerateCommitMsg}
                            disabled={summaries.length === 0 || generatingMsg || !!actionInProgress}
                            data-testid="review-generate-commit-msg"
                          >
                            <Sparkles
                              className={cn('icon-2xs', generatingMsg && 'animate-pulse')}
                            />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          {generatingMsg
                            ? t('review.generatingCommitMsg')
                            : t('review.generateCommitMsg')}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                  <div
                    className={cn(
                      'grid gap-1 mt-2',
                      isOnDifferentBranch
                        ? gitStatus?.prNumber
                          ? 'grid-cols-4'
                          : 'grid-cols-5'
                        : 'grid-cols-3',
                    )}
                  >
                    {[
                      {
                        value: 'commit' as const,
                        icon: GitCommit,
                        label: t('review.commit', 'Commit'),
                        testId: 'review-action-commit',
                      },
                      {
                        value: 'amend' as const,
                        icon: PenLine,
                        label: t('review.amend', 'Amend'),
                        testId: 'review-action-amend',
                      },
                      {
                        value: 'commit-push' as const,
                        icon: Upload,
                        label: t('review.commitAndPush', 'Commit & Push'),
                        testId: 'review-action-commit-push',
                      },
                      ...(!gitStatus?.prNumber && isOnDifferentBranch
                        ? [
                            {
                              value: 'commit-pr' as const,
                              icon: GitPullRequest,
                              label: t('review.commitAndCreatePR', 'Commit & Create PR'),
                              testId: 'review-action-commit-pr',
                            },
                          ]
                        : []),
                      ...(isOnDifferentBranch
                        ? [
                            {
                              value: 'commit-merge' as const,
                              icon: GitMerge,
                              label: t('review.commitAndMerge', 'Commit & Merge'),
                              testId: 'review-action-commit-merge',
                            },
                          ]
                        : []),
                    ].map(({ value, icon: ActionIcon, label, testId }) => (
                      <Tooltip key={value}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => setSelectedAction(value)}
                            disabled={
                              !!actionInProgress || (!!isAgentRunning && !effectiveThreadId)
                            }
                            data-testid={testId}
                            className={cn(
                              'flex flex-col items-center gap-1 rounded-md border p-2 text-center transition-all',
                              'hover:bg-accent/50 disabled:opacity-50 disabled:cursor-not-allowed',
                              selectedAction === value
                                ? 'border-primary bg-primary/5 text-foreground'
                                : 'border-border text-muted-foreground',
                            )}
                          >
                            <ActionIcon
                              className={cn(
                                'icon-base',
                                selectedAction === value && 'text-primary',
                              )}
                            />
                            <span className="text-xs font-medium leading-tight">{label}</span>
                          </button>
                        </TooltipTrigger>
                        {isAgentRunning && (
                          <TooltipContent side="top">
                            {t('review.agentRunningTooltip')}
                          </TooltipContent>
                        )}
                      </Tooltip>
                    ))}
                  </div>
                  <div className="flex gap-1.5">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="flex-1">
                          <Button
                            className="w-full"
                            size="sm"
                            onClick={handleCommitAction}
                            disabled={!canCommit}
                            data-testid="review-commit-execute"
                          >
                            {actionInProgress ? (
                              <Loader2 className="icon-sm mr-1.5 animate-spin" />
                            ) : null}
                            {t('review.continue', 'Continue')}
                          </Button>
                        </div>
                      </TooltipTrigger>
                      {isAgentRunning && (
                        <TooltipContent side="top">
                          {t('review.agentRunningTooltip')}
                        </TooltipContent>
                      )}
                    </Tooltip>
                  </div>
                </div>
              )}

              {/* Rebase conflict resolution — shown when merge/rebase failed with conflicts */}
              {hasRebaseConflict && (
                <div className="flex-shrink-0 space-y-2 border-t border-sidebar-border p-3">
                  <div className="flex items-center gap-2 text-xs text-destructive">
                    <AlertTriangle className="icon-sm" />
                    <span>{t('review.mergeConflict', { target: baseBranch || 'main' })}</span>
                  </div>
                  {isWorktree && (
                    <Button
                      className="w-full"
                      size="sm"
                      variant="outline"
                      onClick={handleOpenInEditorConflict}
                    >
                      <ExternalLink className="icon-sm mr-1.5" />
                      {t('review.openInEditor', {
                        editor: editorLabels[useSettingsStore.getState().defaultEditor],
                      })}
                    </Button>
                  )}
                  <Button className="w-full" size="sm" onClick={handleAskAgentResolve}>
                    <Sparkles className="icon-sm mr-1.5" />
                    {t('review.askAgentResolve')}
                  </Button>
                </div>
              )}
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
          <div className="flex min-h-0 flex-1 flex-col overflow-auto">
            {filteredStashEntries.length === 0 ? (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-muted-foreground">
                <Archive className="h-8 w-8 opacity-40" />
                <p className="text-xs">
                  {currentBranch
                    ? t('review.noStashesOnBranch', {
                        branch: currentBranch,
                        defaultValue: `No stashed changes on ${currentBranch}`,
                      })
                    : t('review.noStashes', 'No stashed changes')}
                </p>
                {stashEntries.length > 0 && (
                  <p className="text-[10px] opacity-60">
                    {t('review.stashesOnOtherBranches', {
                      count: stashEntries.length,
                      defaultValue: `${stashEntries.length} stash(es) on other branches`,
                    })}
                  </p>
                )}
              </div>
            ) : (
              <div className="flex flex-col divide-y divide-sidebar-border">
                {filteredStashEntries.map((entry) => {
                  const idx = entry.index.replace('stash@{', '').replace('}', '');
                  const isExpanded = expandedStashIndex === idx;
                  return (
                    <div key={entry.index} className="flex flex-col">
                      <div
                        role="button"
                        tabIndex={0}
                        className={cn(
                          'flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs hover:bg-sidebar-accent/50 transition-colors',
                          isExpanded && 'bg-sidebar-accent/30',
                        )}
                        onClick={() => {
                          if (isExpanded) {
                            setExpandedStashIndex(null);
                            setStashFiles([]);
                          } else {
                            setExpandedStashIndex(idx);
                            loadStashFiles(idx);
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            if (isExpanded) {
                              setExpandedStashIndex(null);
                              setStashFiles([]);
                            } else {
                              setExpandedStashIndex(idx);
                              loadStashFiles(idx);
                            }
                          }
                        }}
                        data-testid={`stash-entry-${idx}`}
                      >
                        <ChevronRight
                          className={cn(
                            'h-3 w-3 shrink-0 transition-transform',
                            isExpanded && 'rotate-90',
                          )}
                        />
                        <div className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate font-medium">{entry.message}</span>
                          <span className="text-[10px] text-muted-foreground">
                            {entry.relativeDate}
                          </span>
                        </div>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="shrink-0 text-muted-foreground"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleStashPop();
                              }}
                              disabled={stashPopInProgress || !!isAgentRunning || idx !== '0'}
                              data-testid={`stash-pop-${idx}`}
                            >
                              {stashPopInProgress && idx === '0' ? (
                                <Loader2 className="icon-sm animate-spin" />
                              ) : (
                                <ArchiveRestore className="icon-sm" />
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="left">
                            {idx === '0'
                              ? t('review.popStash', 'Pop stash')
                              : t(
                                  'review.popStashOnlyLatest',
                                  'Only the latest stash can be popped',
                                )}
                          </TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="shrink-0 text-muted-foreground hover:text-destructive"
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmDialog({ type: 'drop-stash', stashIndex: idx });
                              }}
                              disabled={!!stashDropInProgress || !!isAgentRunning}
                              data-testid={`stash-drop-${idx}`}
                            >
                              {stashDropInProgress === idx ? (
                                <Loader2 className="icon-sm animate-spin" />
                              ) : (
                                <Trash2 className="icon-sm" />
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="left">
                            {t('review.dropStash', 'Discard stash')}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                      {isExpanded && (
                        <div className="border-t border-sidebar-border/50 bg-sidebar-accent/20">
                          {stashFilesLoading ? (
                            <div className="flex items-center gap-2 px-6 py-2 text-xs text-muted-foreground">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              {t('review.loading', 'Loading...')}
                            </div>
                          ) : stashFiles.length === 0 ? (
                            <div className="px-6 py-2 text-xs text-muted-foreground">
                              {t('review.noFiles', 'No files')}
                            </div>
                          ) : (
                            stashFiles.map((file) => (
                              <div
                                key={file.path}
                                className="flex items-center gap-2 px-6 py-1 text-xs"
                                data-testid={`stash-file-${file.path}`}
                              >
                                <FileExtensionIcon
                                  filePath={file.path}
                                  className="h-3.5 w-3.5 shrink-0"
                                />
                                <span className="min-w-0 flex-1 truncate text-foreground/80">
                                  {file.path}
                                </span>
                                <span className="shrink-0 tabular-nums text-green-500">
                                  +{file.additions}
                                </span>
                                <span className="shrink-0 tabular-nums text-red-500">
                                  -{file.deletions}
                                </span>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
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
              await executeStashDrop(dialog.stashIndex);
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

        {/* Create PR dialog */}
        <Dialog
          open={!!prDialog}
          onOpenChange={(open) => {
            if (!open) setPrDialog(null);
          }}
        >
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>{t('review.createPR')}</DialogTitle>
              <DialogDescription>
                {t('review.createPRTooltip', {
                  branch: threadBranch,
                  target: baseBranch || 'base',
                })}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Input
                placeholder={t('review.prTitle', 'PR title')}
                data-testid="review-pr-title"
                value={prDialog?.title ?? ''}
                onChange={(e) =>
                  setPrDialog((prev) => (prev ? { ...prev, title: e.target.value } : prev))
                }
              />
              <textarea
                className="w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
                rows={4}
                placeholder={t('review.commitBody', 'Description (optional)')}
                data-testid="review-pr-body"
                value={prDialog?.body ?? ''}
                onChange={(e) =>
                  setPrDialog((prev) => (prev ? { ...prev, body: e.target.value } : prev))
                }
              />
            </div>
            <div className="mt-2 flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPrDialog(null)}
                data-testid="review-pr-cancel"
              >
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button
                size="sm"
                disabled={!prDialog?.title.trim() || prInProgress}
                onClick={handleCreatePROnly}
                data-testid="review-pr-create"
              >
                {prInProgress ? (
                  <Loader2 className="icon-sm mr-1.5 animate-spin" />
                ) : (
                  <GitPullRequest className="icon-sm mr-1.5" />
                )}
                {t('review.createPR')}
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* Merge into branch dialog */}
        <Dialog
          open={!!mergeDialog}
          onOpenChange={(open) => {
            if (!open) setMergeDialog(null);
          }}
        >
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>
                {t('review.mergeIntoBranch', { target: '', defaultValue: 'Merge into branch' })}
              </DialogTitle>
              <DialogDescription>
                {t('review.mergeDescription', {
                  source: currentBranch,
                  defaultValue: `Merge ${currentBranch} into the selected target branch.`,
                })}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">
                {t('review.targetBranch', 'Target branch')}
              </label>
              {mergeDialog?.loading ? (
                <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                  <Loader2 className="icon-sm animate-spin" />
                  {t('common.loading', 'Loading...')}
                </div>
              ) : (
                <Select
                  value={mergeDialog?.targetBranch}
                  onValueChange={(v) =>
                    setMergeDialog((prev) => (prev ? { ...prev, targetBranch: v } : null))
                  }
                >
                  <SelectTrigger className="h-8 text-xs" data-testid="review-merge-target-select">
                    <SelectValue placeholder={t('review.selectBranch', 'Select branch')} />
                  </SelectTrigger>
                  <SelectContent>
                    {mergeDialog?.branches.map((b) => (
                      <SelectItem key={b} value={b} className="text-xs">
                        {b}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="mt-2 flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setMergeDialog(null)}
                data-testid="review-merge-cancel"
              >
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button
                size="sm"
                disabled={!mergeDialog?.targetBranch || mergeDialog?.loading || mergeInProgress}
                onClick={handleMergeWithTarget}
                data-testid="review-merge-confirm"
              >
                {mergeInProgress ? (
                  <Loader2 className="icon-sm mr-1.5 animate-spin" />
                ) : (
                  <GitMerge className="icon-sm mr-1.5" />
                )}
                {t('review.merge', 'Merge')}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
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
