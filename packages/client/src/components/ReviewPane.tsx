import type { FileDiffSummary } from '@funny/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  RefreshCw,
  FileCode,
  FilePlus,
  FileX,
  PanelRightClose,
  Maximize2,
  Search,
  X,
  GitCommit,
  GitMerge,
  Upload,
  Download,
  GitPullRequest,
  Sparkles,
  Loader2,
  Check,
  MoreVertical,
  Undo2,
  EyeOff,
  Folder,
  FolderOpen,
  FolderX,
  Copy,
  ClipboardCopy,
  ExternalLink,
  AlertTriangle,
  History,
  Archive,
  ArchiveRestore,
  PenLine,
  RotateCcw,
  ChevronRight,
} from 'lucide-react';
import { useState, useEffect, useRef, useMemo, useCallback, memo, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/ConfirmDialog';
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
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAutoRefreshDiff } from '@/hooks/use-auto-refresh-diff';
import { api } from '@/lib/api';
import { openFileInEditor, getEditorLabel } from '@/lib/editor-utils';
import { FileExtensionIcon } from '@/lib/file-icons';
import { cn } from '@/lib/utils';
import { useCommitProgressStore } from '@/stores/commit-progress-store';
import { useDraftStore } from '@/stores/draft-store';
import { useGitStatusStore, useGitStatusForThread } from '@/stores/git-status-store';
import { useProjectStore } from '@/stores/project-store';
import { useSettingsStore, deriveToolLists } from '@/stores/settings-store';
import { editorLabels } from '@/stores/settings-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

import { InlineProgressSteps } from './InlineProgressSteps';
import { ReactDiffViewer, DIFF_VIEWER_STYLES } from './tool-cards/utils';

const fileStatusIcons: Record<string, typeof FileCode> = {
  added: FilePlus,
  modified: FileCode,
  deleted: FileX,
  renamed: FileCode,
};

const FILE_ROW_HEIGHT = 24;
const FOLDER_ROW_HEIGHT = 22;
const INDENT_PX = 12;

type TreeRow =
  | { kind: 'folder'; path: string; label: string; depth: number; fileCount: number }
  | { kind: 'file'; file: FileDiffSummary; depth: number };

interface FolderNode {
  children: Map<string, FolderNode>;
  files: FileDiffSummary[];
}

function buildTreeRows(diffs: FileDiffSummary[], collapsed: Set<string>): TreeRow[] {
  // Build tree
  const root: FolderNode = { children: new Map(), files: [] };
  for (const f of diffs) {
    const parts = f.path.split('/');
    parts.pop(); // remove filename, keep only directory parts
    let node = root;
    for (const part of parts) {
      if (!node.children.has(part)) {
        node.children.set(part, { children: new Map(), files: [] });
      }
      node = node.children.get(part)!;
    }
    node.files.push(f);
  }

  // Count all files under a node
  function countFiles(node: FolderNode): number {
    let count = node.files.length;
    for (const child of node.children.values()) {
      count += countFiles(child);
    }
    return count;
  }

  // Flatten with path compaction (merge single-child intermediate dirs)
  const rows: TreeRow[] = [];

  function flatten(node: FolderNode, depth: number, pathPrefix: string) {
    // Sort folders first, then files
    const sortedFolders = [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b));

    for (const [name, child] of sortedFolders) {
      // Compact: merge single-subfolder chains with no files
      let compactedName = name;
      let current = child;
      let currentPath = pathPrefix ? `${pathPrefix}/${name}` : name;
      while (current.files.length === 0 && current.children.size === 1) {
        const [nextName, nextChild] = [...current.children.entries()][0];
        compactedName += `/${nextName}`;
        currentPath += `/${nextName}`;
        current = nextChild;
      }

      const folderPath = currentPath;
      const fileCount = countFiles(current);

      rows.push({
        kind: 'folder',
        path: folderPath,
        label: compactedName,
        depth,
        fileCount,
      });

      if (!collapsed.has(folderPath)) {
        flatten(current, depth + 1, currentPath);
      }
    }

    // Files at root level (no folder)
    for (const file of node.files.sort((a, b) => a.path.localeCompare(b.path))) {
      rows.push({ kind: 'file', file, depth });
    }
  }

  flatten(root, 0, '');
  return rows;
}

function parseDiffOld(unifiedDiff: string): string {
  const lines = unifiedDiff.split('\n');
  const oldLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) {
      continue;
    }
    if (line.startsWith('-')) {
      oldLines.push(line.substring(1));
    } else if (!line.startsWith('+')) {
      oldLines.push(line);
    }
  }

  return oldLines.join('\n');
}

function parseDiffNew(unifiedDiff: string): string {
  const lines = unifiedDiff.split('\n');
  const newLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) {
      continue;
    }
    if (line.startsWith('+')) {
      newLines.push(line.substring(1));
    } else if (!line.startsWith('-')) {
      newLines.push(line);
    }
  }

  return newLines.join('\n');
}

const MemoizedDiffView = memo(function MemoizedDiffView({
  diff,
  splitView = false,
}: {
  diff: string;
  splitView?: boolean;
}) {
  const oldValue = useMemo(() => parseDiffOld(diff), [diff]);
  const newValue = useMemo(() => parseDiffNew(diff), [diff]);

  return (
    <ReactDiffViewer
      oldValue={oldValue}
      newValue={newValue}
      splitView={splitView}
      useDarkTheme={true}
      hideLineNumbers={false}
      showDiffOnly={true}
      hideSummary={true}
      styles={DIFF_VIEWER_STYLES}
      codeFoldMessageRenderer={() => <></>}
    />
  );
});

export function ReviewPane() {
  const { t } = useTranslation();
  const setReviewPaneOpen = useUIStore((s) => s.setReviewPaneOpen);
  const reviewPaneOpen = useUIStore((s) => s.reviewPaneOpen);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);

  // Derive effectiveThreadId from the active thread only.
  // Never fall back to the first thread in the project list — that can return
  // a worktree thread when the user selected a local (master) thread, causing
  // the review pane to show diff data from the wrong working directory.
  const effectiveThreadId = useThreadStore((s) => s.activeThread?.id);

  // When no thread is active but a project is selected, use project-based git endpoints
  const projectModeId = !effectiveThreadId ? selectedProjectId : null;
  // Either we have a thread or a project — at least one must be set for git operations
  const hasGitContext = !!(effectiveThreadId || projectModeId);

  // The base directory path for constructing absolute file paths (worktree path or project path)
  const basePath = useThreadStore((s) => {
    const wt = s.activeThread?.worktreePath;
    if (wt) return wt;
    const pid = s.activeThread?.projectId ?? selectedProjectId;
    if (!pid) return '';
    return useProjectStore.getState().projects.find((p) => p.id === pid)?.path ?? '';
  });

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

  // Wrap setters to also persist to draft store
  const draftId = effectiveThreadId || projectModeId;
  const setCommitTitle = useCallback(
    (v: string | ((prev: string) => string)) => {
      setCommitTitleRaw((prev) => {
        const next = typeof v === 'function' ? v(prev) : v;
        if (draftId) {
          // Read current body from state for sync
          setCommitBodyRaw((body) => {
            setCommitDraft(draftId, next, body);
            return body;
          });
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
          setCommitTitleRaw((title) => {
            setCommitDraft(draftId, title, next);
            return title;
          });
        }
        return next;
      });
    },
    [draftId, setCommitDraft],
  );
  const [generatingMsg, setGeneratingMsg] = useState(false);
  const [selectedAction, setSelectedAction] = useState<
    'commit' | 'commit-push' | 'commit-pr' | 'commit-merge' | 'amend'
  >('commit');
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  // New git operations state
  const [logEntries, setLogEntries] = useState<
    Array<{
      hash: string;
      shortHash: string;
      author: string;
      relativeDate: string;
      message: string;
    }>
  >([]);
  const [logOpen, setLogOpen] = useState(false);
  const [logLoading, setLogLoading] = useState(false);
  const [pullInProgress, setPullInProgress] = useState(false);
  const [stashInProgress, setStashInProgress] = useState(false);
  const [stashEntries, setStashEntries] = useState<
    Array<{ index: string; message: string; relativeDate: string }>
  >([]);
  const [stashPopInProgress, setStashPopInProgress] = useState(false);
  const [resetInProgress, setResetInProgress] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{
    type: 'revert' | 'reset' | 'discard-all';
    path?: string;
    paths?: string[];
  } | null>(null);

  const isWorktree = useThreadStore((s) => s.activeThread?.mode === 'worktree');
  const baseBranch = useThreadStore((s) => s.activeThread?.baseBranch);
  const threadBranch = useThreadStore((s) => s.activeThread?.branch);
  const _hasWorktreePath = useThreadStore((s) => !!s.activeThread?.worktreePath);
  const isAgentRunning = useThreadStore((s) => s.activeThread?.status === 'running');
  const gitStatus = useGitStatusForThread(effectiveThreadId);
  const [mergeInProgress, setMergeInProgress] = useState(false);
  const [pushInProgress, setPushInProgress] = useState(false);
  const [prInProgress, setPrInProgress] = useState(false);
  const [prDialog, setPrDialog] = useState<{ title: string; body: string } | null>(null);
  const [hasRebaseConflict, setHasRebaseConflict] = useState(false);
  const commitLockRef = useRef(false);

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
      // Refresh diffs and git status
      refresh();
      if (effectiveThreadId && prev.action === 'commit-merge') {
        useThreadStore.getState().refreshActiveThread();
      }
      if (effectiveThreadId && prev.action === 'merge') {
        useThreadStore.getState().refreshActiveThread();
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
      const action = commitEntry.action;
      if (action === 'push') {
        toast.success(t('review.pushSuccess', 'Pushed successfully'));
      } else if (action === 'merge') {
        toast.success(t('review.mergeSuccess', 'Merged successfully'));
      } else if (action === 'create-pr') {
        toast.success(t('review.prSuccess', 'Pull request created'));
      } else {
        toast.success(t('review.commitSuccess', 'Changes committed successfully'));
      }
    }
  }, [commitEntry]); // eslint-disable-line react-hooks/exhaustive-deps

  // Show standalone merge button when no dirty files but branch has unmerged commits.
  // Works in both worktree and local mode — as long as the thread is on a different branch from base.
  const isOnDifferentBranch =
    !!effectiveThreadId && !!baseBranch && !!threadBranch && threadBranch !== baseBranch;
  const showMergeOnly =
    isOnDifferentBranch &&
    summaries.length === 0 &&
    !loading &&
    gitStatus &&
    !gitStatus.isMergedIntoBase &&
    !hasRebaseConflict;

  // Show standalone push button when no dirty files but there are unpushed commits
  const showPushOnly =
    summaries.length === 0 &&
    !loading &&
    gitStatus &&
    gitStatus.unpushedCommitCount > 0 &&
    !hasRebaseConflict;

  const fileListRef = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    if (!hasGitContext) return;
    setLoading(true);
    setLoadError(false);

    // Fire git status refresh in parallel (don't await — it updates its own store)
    if (effectiveThreadId) useGitStatusStore.getState().fetchForThread(effectiveThreadId);
    else if (projectModeId) useGitStatusStore.getState().fetchProjectStatus(projectModeId);

    const result = effectiveThreadId
      ? await api.getDiffSummary(effectiveThreadId)
      : await api.projectDiffSummary(projectModeId!);
    if (result.isOk()) {
      const data = result.value;
      setSummaries(data.files);
      setTruncatedInfo({ total: data.total, truncated: data.truncated });
      // Invalidate only stale cache entries instead of clearing the whole map
      const newPaths = new Set(data.files.map((d) => d.path));
      setDiffCache((prev) => {
        const next = new Map<string, string>();
        for (const [k, v] of prev) {
          if (newPaths.has(k)) next.set(k, v);
        }
        return next;
      });
      // Check all files by default, preserving existing selections
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
      // Load diff for the currently selected file (uses cache if still valid)
      const fileToLoad = selectedFile ?? (data.files.length > 0 ? data.files[0].path : null);
      if (fileToLoad) {
        const summary = data.files.find((s) => s.path === fileToLoad);
        if (summary) {
          // Skip fetch if cached content is still valid (file still in summary)
          const cachedDiff = diffCache.get(fileToLoad);
          if (!cachedDiff) {
            setLoadingDiff(fileToLoad);
            const diffResult = effectiveThreadId
              ? await api.getFileDiff(effectiveThreadId, fileToLoad, summary.staged)
              : await api.projectFileDiff(projectModeId!, fileToLoad, summary.staged);
            if (diffResult.isOk()) {
              setDiffCache((prev) => new Map(prev).set(fileToLoad, diffResult.value.diff));
            }
            setLoadingDiff((prev) => (prev === fileToLoad ? null : prev));
          }
        }
      }
    } else {
      console.error('Failed to load diff summary:', result.error);
      setLoadError(true);
    }
    setLoading(false);
  };

  // Lazy load diff content for the selected file
  const loadDiffForFile = async (filePath: string) => {
    if (!hasGitContext || diffCache.has(filePath)) return;
    const summary = summaries.find((s) => s.path === filePath);
    if (!summary) return;
    setLoadingDiff(filePath);
    const result = effectiveThreadId
      ? await api.getFileDiff(effectiveThreadId, filePath, summary.staged)
      : await api.projectFileDiff(projectModeId!, filePath, summary.staged);
    if (result.isOk()) {
      setDiffCache((prev) => new Map(prev).set(filePath, result.value.diff));
    }
    setLoadingDiff((prev) => (prev === filePath ? null : prev));
  };

  // Load diff when selected file or expanded file changes
  useEffect(() => {
    if (selectedFile && !diffCache.has(selectedFile)) {
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

  // Reset state and refresh when the active thread or project-mode changes.
  // Using effectiveThreadId (not just gitContextKey) ensures we refresh even
  // when switching between two local threads of the same project that share
  // the same git working directory.
  const gitContextKey = effectiveThreadId || projectModeId;
  useEffect(() => {
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
    // When visible, defer via rAF so state resets paint before the async fetch starts.
    if (reviewPaneOpen) {
      const rafId = requestAnimationFrame(() => refresh());
      return () => cancelAnimationFrame(rafId);
    } else {
      needsRefreshRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset+refresh on context change only; refresh/reviewPaneOpen are read but not deps (handled separately)
  }, [gitContextKey]);

  // Fire deferred refresh when the review pane becomes visible.
  // Uses requestAnimationFrame to yield to the browser first so it can paint
  // the pane opening animation before we start the async fetch.
  useEffect(() => {
    if (reviewPaneOpen && needsRefreshRef.current) {
      needsRefreshRef.current = false;
      const rafId = requestAnimationFrame(() => {
        refresh();
      });
      return () => cancelAnimationFrame(rafId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh is a non-memoized function; only trigger on pane visibility change
  }, [reviewPaneOpen]);

  // Auto-refresh diffs when agent modifies files (debounced 2s)
  useAutoRefreshDiff(effectiveThreadId, refresh, 2000);

  const filteredDiffs = useMemo(() => {
    if (!fileSearch) return summaries;
    const query = fileSearch.toLowerCase();
    return summaries.filter((d) => d.path.toLowerCase().includes(query));
  }, [summaries, fileSearch]);

  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());

  const treeRows = useMemo(
    () => buildTreeRows(filteredDiffs, collapsedFolders),
    [filteredDiffs, collapsedFolders],
  );

  const toggleFolder = useCallback((folderPath: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  }, []);

  const selectedDiffContent = selectedFile ? diffCache.get(selectedFile) : undefined;

  const checkedCount = checkedFiles.size;
  const totalCount = summaries.length;

  const virtualizer = useVirtualizer({
    count: treeRows.length,
    getScrollElement: () => fileListRef.current,
    estimateSize: (index) =>
      treeRows[index]?.kind === 'folder' ? FOLDER_ROW_HEIGHT : FILE_ROW_HEIGHT,
    getItemKey: (index) => {
      const row = treeRows[index];
      return row.kind === 'folder' ? `d:${row.path}` : `f:${row.file.path}`;
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
    if (checkedFiles.size === summaries.length) {
      setCheckedFiles(new Set());
    } else {
      setCheckedFiles(new Set(summaries.map((d) => d.path)));
    }
  };

  const handleGenerateCommitMsg = async () => {
    if (!hasGitContext || generatingMsg) return;
    setGeneratingMsg(true);
    const result = effectiveThreadId
      ? await api.generateCommitMessage(effectiveThreadId, true)
      : await api.projectGenerateCommitMessage(projectModeId!, true);
    if (result.isOk()) {
      setCommitTitle(result.value.title);
      setCommitBody(result.value.body);
    } else {
      toast.error(t('review.generateFailed', { message: result.error.message }));
    }
    setGeneratingMsg(false);
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
        toast.error(result.error.message);
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
      toast.error(result.error.message);
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
      toast.error(result.error.message);
      setPushInProgress(false);
    }
    // pushInProgress will be cleared by the useEffect watching commitEntry
  };

  const handleMergeOnly = async () => {
    if (!hasGitContext || mergeInProgress) return;
    setMergeInProgress(true);

    const result = effectiveThreadId
      ? await api.startWorkflow(effectiveThreadId, { action: 'merge', cleanup: true })
      : await api.projectStartWorkflow(projectModeId!, { action: 'merge', cleanup: true });

    if (result.isErr()) {
      toast.error(result.error.message);
      setMergeInProgress(false);
    }
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
      toast.error(result.error.message);
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
      toast.error(result.error.message);
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
    const text = relative ? path : `/${path}`;
    navigator.clipboard.writeText(text);
    toast.success(t('review.pathCopied'));
  };

  // ── New git operation handlers ──

  const handleLoadLog = async () => {
    if (!hasGitContext || logLoading) return;
    setLogLoading(true);
    const result = effectiveThreadId
      ? await api.getGitLog(effectiveThreadId, 20)
      : await api.projectGitLog(projectModeId!, 20);
    if (result.isOk()) {
      setLogEntries(result.value.entries);
    } else {
      toast.error(
        t('review.logFailed', {
          message: result.error.message,
          defaultValue: `Failed to load log: ${result.error.message}`,
        }),
      );
    }
    setLogLoading(false);
  };

  const handlePull = async () => {
    if (!hasGitContext || pullInProgress) return;
    setPullInProgress(true);
    const result = effectiveThreadId
      ? await api.pull(effectiveThreadId)
      : await api.projectPull(projectModeId!);
    if (result.isErr()) {
      toast.error(
        t('review.pullFailed', {
          message: result.error.message,
          defaultValue: `Pull failed: ${result.error.message}`,
        }),
      );
    } else {
      toast.success(t('review.pullSuccess', 'Pulled successfully'));
    }
    setPullInProgress(false);
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

  const refreshStashList = async () => {
    if (!hasGitContext) return;
    const result = effectiveThreadId
      ? await api.stashList(effectiveThreadId)
      : await api.projectStashList(projectModeId!);
    if (result.isOk()) {
      setStashEntries(result.value.entries);
    }
  };

  const handleResetSoft = () => {
    setConfirmDialog({ type: 'reset' });
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

  // Load stash list on mount / thread change (only when pane is visible)
  useEffect(() => {
    if (reviewPaneOpen) {
      refreshStashList();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshStashList is a non-memoized function; only trigger on context/visibility change
  }, [gitContextKey, reviewPaneOpen]);

  // When a thread is active, commits are delegated to the agent, so allow even if agent is running
  const canCommit =
    checkedFiles.size > 0 &&
    commitTitle.trim().length > 0 &&
    !actionInProgress &&
    (effectiveThreadId ? true : !isAgentRunning);

  return (
    <div className="flex h-full flex-col" style={{ contain: 'strict' }}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-sidebar-border px-4 py-3">
        <div className="flex items-center gap-1">
          <h3 className="mr-1 text-xs font-semibold uppercase tracking-wider text-sidebar-foreground">
            {t('review.title')}
          </h3>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setReviewPaneOpen(false)}
              className="text-muted-foreground"
              data-testid="review-close"
            >
              <PanelRightClose className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{t('review.close', 'Close')}</TooltipContent>
        </Tooltip>
      </div>

      {/* Two-column layout: diff left, files right */}
      <div className="flex min-h-0 flex-1">
        {/* Left: Diff viewer */}
        <div className="flex min-w-0 flex-1 flex-col">
          {selectedFile && (
            <div className="flex flex-shrink-0 items-center gap-2 border-b border-sidebar-border px-3 py-1.5">
              <span
                role="button"
                tabIndex={0}
                onClick={() => {
                  const fullPath = basePath ? `${basePath}/${selectedFile}` : selectedFile;
                  openFileInEditor(fullPath);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    const fullPath = basePath ? `${basePath}/${selectedFile}` : selectedFile;
                    openFileInEditor(fullPath);
                  }
                }}
                className="min-w-0 flex-1 cursor-pointer truncate font-mono text-xs text-muted-foreground hover:text-primary hover:underline"
                title={selectedFile}
                style={{ direction: 'rtl', textAlign: 'left' }}
                data-testid="review-open-selected-file"
              >
                {selectedFile}
              </span>
              {selectedDiffContent && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => setExpandedFile(selectedFile)}
                      className="flex-shrink-0 text-muted-foreground hover:text-foreground"
                      data-testid="review-expand-diff"
                    >
                      <Maximize2 className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left">{t('review.expand', 'Expand')}</TooltipContent>
                </Tooltip>
              )}
            </div>
          )}
          <ScrollArea className="w-full flex-1">
            {selectedFile ? (
              loadingDiff === selectedFile ? (
                <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading diff\u2026
                </div>
              ) : selectedDiffContent ? (
                <div className="relative text-xs [&_.diff-container]:font-mono [&_table]:w-max [&_td:last-child]:w-auto [&_td:last-child]:min-w-0">
                  <Suspense
                    fallback={
                      <div className="p-2 text-xs text-muted-foreground">Loading diff\u2026</div>
                    }
                  >
                    <MemoizedDiffView diff={selectedDiffContent} />
                  </Suspense>
                </div>
              ) : (
                <p className="p-2 text-xs text-muted-foreground">{t('review.binaryOrNoDiff')}</p>
              )
            ) : (
              <p className="p-2 text-xs text-muted-foreground">{t('review.selectFile')}</p>
            )}
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        </div>

        {/* Right: File list panel */}
        <div className="flex w-[352px] flex-shrink-0 flex-col border-l border-sidebar-border">
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

          {/* Toolbar icons */}
          <div className="flex items-center gap-0.5 border-b border-sidebar-border px-2 py-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={refresh}
                  className="text-muted-foreground"
                  data-testid="review-refresh"
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{t('review.refresh')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={handlePull}
                  disabled={pullInProgress}
                  className="text-muted-foreground"
                  data-testid="review-pull"
                >
                  <Download className={cn('h-3.5 w-3.5', pullInProgress && 'animate-pulse')} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{t('review.pull', 'Pull')}</TooltipContent>
            </Tooltip>
            <Popover
              open={logOpen}
              onOpenChange={(open) => {
                setLogOpen(open);
                if (open) handleLoadLog();
              }}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground"
                      data-testid="review-commit-log"
                    >
                      <History className="h-3.5 w-3.5" />
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent side="top">{t('review.log', 'Commit log')}</TooltipContent>
              </Tooltip>
              <PopoverContent align="start" className="max-h-[360px] w-[400px] overflow-auto p-0">
                {logLoading ? (
                  <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t('review.loadingLog', 'Loading commits\u2026')}
                  </div>
                ) : logEntries.length === 0 ? (
                  <p className="p-3 text-xs text-muted-foreground">
                    {t('review.noCommits', 'No commits yet')}
                  </p>
                ) : (
                  <div className="divide-y divide-border">
                    {logEntries.map((entry) => (
                      <div key={entry.hash} className="px-3 py-2 text-xs hover:bg-accent/50">
                        <div className="flex items-center gap-2">
                          <code className="font-mono text-[10px] text-primary">
                            {entry.shortHash}
                          </code>
                          <span className="text-muted-foreground">{entry.relativeDate}</span>
                        </div>
                        <p className="mt-0.5 truncate text-foreground">{entry.message}</p>
                        <p className="text-[10px] text-muted-foreground">{entry.author}</p>
                      </div>
                    ))}
                  </div>
                )}
              </PopoverContent>
            </Popover>
            {summaries.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={handleStash}
                    disabled={stashInProgress || !!isAgentRunning}
                    className="text-muted-foreground"
                    data-testid="review-stash"
                  >
                    <Archive className={cn('h-3.5 w-3.5', stashInProgress && 'animate-pulse')} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {isAgentRunning
                    ? t('review.agentRunningTooltip')
                    : t('review.stash', 'Stash changes')}
                </TooltipContent>
              </Tooltip>
            )}
            {summaries.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={handleDiscardAll}
                    disabled={!!actionInProgress || !!isAgentRunning}
                    className="text-muted-foreground"
                    data-testid="review-discard-all"
                  >
                    <Undo2 className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {isAgentRunning
                    ? t('review.agentRunningTooltip')
                    : t('review.discard', 'Discard')}
                </TooltipContent>
              </Tooltip>
            )}
          </div>

          {/* File search */}
          {summaries.length > 0 && (
            <div className="border-b border-sidebar-border px-2 py-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
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
                    <X className="h-3 w-3" />
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Select all / count */}
          {summaries.length > 0 && (
            <div className="flex items-center gap-1.5 border-b border-sidebar-border py-1.5 pl-2 pr-4">
              <button
                role="checkbox"
                aria-checked={
                  checkedFiles.size === summaries.length
                    ? true
                    : checkedFiles.size > 0
                      ? 'mixed'
                      : false
                }
                aria-label={t('review.selectAll', 'Select all files')}
                data-testid="review-select-all"
                onClick={toggleAll}
                className={cn(
                  'flex items-center justify-center h-3.5 w-3.5 rounded border transition-colors flex-shrink-0',
                  checkedFiles.size === summaries.length
                    ? 'bg-primary border-primary text-primary-foreground'
                    : checkedFiles.size > 0
                      ? 'bg-primary/50 border-primary text-primary-foreground'
                      : 'border-muted-foreground/40',
                )}
              >
                {checkedFiles.size > 0 && <Check className="h-2.5 w-2.5" />}
              </button>
              <span className="text-xs text-muted-foreground">
                {checkedCount}/{totalCount} {t('review.selected', 'selected')}
              </span>
            </div>
          )}

          {/* File list (virtualized) */}
          {loading ? (
            <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('review.loading', 'Loading changes\u2026')}
            </div>
          ) : loadError ? (
            <div className="flex flex-col items-center gap-2 p-4 text-xs text-muted-foreground">
              <AlertTriangle className="h-4 w-4 text-status-error" />
              <p>{t('review.loadFailed', 'Failed to load changes')}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={refresh}
                className="mt-1 gap-1.5"
                data-testid="review-retry"
              >
                <RotateCcw className="h-3 w-3" />
                {t('common.retry', 'Retry')}
              </Button>
            </div>
          ) : summaries.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">{t('review.noChanges')}</p>
          ) : filteredDiffs.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">
              {t('review.noMatchingFiles', 'No matching files')}
            </p>
          ) : (
            <div ref={fileListRef} className="flex-1 overflow-auto">
              <div
                style={{
                  height: `${virtualizer.getTotalSize()}px`,
                  width: '100%',
                  position: 'relative',
                }}
              >
                {virtualizer.getVirtualItems().map((virtualRow) => {
                  const row = treeRows[virtualRow.index];
                  const baseStyle = {
                    position: 'absolute' as const,
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  };

                  if (row.kind === 'folder') {
                    const isCollapsed = collapsedFolders.has(row.path);
                    return (
                      <div
                        key={`folder-${row.path}`}
                        className="flex cursor-pointer select-none items-center gap-1 text-xs text-muted-foreground/80 hover:bg-sidebar-accent/30"
                        style={{ ...baseStyle, paddingLeft: `${8 + row.depth * INDENT_PX}px` }}
                        onClick={() => toggleFolder(row.path)}
                        data-testid={`review-folder-${row.path}`}
                      >
                        <ChevronRight
                          className={cn(
                            'h-3 w-3 flex-shrink-0 transition-transform',
                            !isCollapsed && 'rotate-90',
                          )}
                        />
                        {isCollapsed ? (
                          <Folder className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/70" />
                        ) : (
                          <FolderOpen className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/70" />
                        )}
                        <span className="truncate text-xs font-medium">{row.label}</span>
                      </div>
                    );
                  }

                  const f = row.file;
                  const isChecked = checkedFiles.has(f.path);
                  return (
                    <div
                      key={f.path}
                      style={{ ...baseStyle, paddingLeft: `${8 + row.depth * INDENT_PX}px` }}
                      className={cn(
                        'group flex items-center gap-1.5 text-xs cursor-pointer transition-colors',
                        selectedFile === f.path
                          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                          : 'hover:bg-sidebar-accent/50 text-muted-foreground',
                      )}
                      onClick={() => setSelectedFile(f.path)}
                    >
                      <button
                        role="checkbox"
                        aria-checked={isChecked}
                        aria-label={t('review.selectFile', {
                          file: f.path,
                          defaultValue: `Select ${f.path}`,
                        })}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFile(f.path);
                        }}
                        className={cn(
                          'flex items-center justify-center h-3.5 w-3.5 rounded border transition-colors flex-shrink-0',
                          isChecked
                            ? 'bg-primary border-primary text-primary-foreground'
                            : 'border-muted-foreground/40',
                        )}
                      >
                        {isChecked && <Check className="h-2.5 w-2.5" />}
                      </button>
                      <FileExtensionIcon
                        filePath={f.path}
                        className="h-4 w-4 flex-shrink-0 text-muted-foreground/80"
                      />
                      <span className="flex-1 truncate font-mono text-xs">
                        {f.path.split('/').pop()}
                      </span>
                      <span
                        className={cn(
                          'text-[10px] font-medium flex-shrink-0',
                          f.status === 'added' && 'text-diff-added',
                          f.status === 'modified' && 'text-status-pending',
                          f.status === 'deleted' && 'text-diff-removed',
                          f.status === 'renamed' && 'text-status-info',
                        )}
                      >
                        {f.status === 'added'
                          ? 'A'
                          : f.status === 'modified'
                            ? 'M'
                            : f.status === 'deleted'
                              ? 'D'
                              : 'R'}
                      </span>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            onClick={(e) => e.stopPropagation()}
                            aria-label={t('review.moreActions', 'More actions')}
                            className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-all hover:text-foreground group-hover:opacity-100 data-[state=open]:opacity-100"
                          >
                            <MoreVertical className="h-3 w-3" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-[220px]">
                          <DropdownMenuItem
                            onClick={() => {
                              const fullPath = basePath ? `${basePath}/${f.path}` : f.path;
                              openFileInEditor(fullPath);
                            }}
                          >
                            <ExternalLink />
                            {t('review.openInEditor', { editor: getEditorLabel() })}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => handleRevertFile(f.path)}
                            className="text-destructive focus:text-destructive"
                          >
                            <Undo2 />
                            {t('review.discardChanges')}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => handleIgnore(f.path)}>
                            <EyeOff />
                            {t('review.ignoreFile')}
                          </DropdownMenuItem>
                          {(() => {
                            const folders = getParentFolders(f.path);
                            if (folders.length === 0) return null;
                            if (folders.length === 1) {
                              return (
                                <DropdownMenuItem onClick={() => handleIgnore(folders[0])}>
                                  <FolderX />
                                  {t('review.ignoreFolder')}
                                </DropdownMenuItem>
                              );
                            }
                            return (
                              <DropdownMenuSub>
                                <DropdownMenuSubTrigger>
                                  <FolderX />
                                  {t('review.ignoreFolder')}
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent>
                                  {folders.map((folder) => (
                                    <DropdownMenuItem
                                      key={folder}
                                      onClick={() => handleIgnore(folder)}
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
                              <DropdownMenuItem onClick={() => handleIgnore(`*${ext}`)}>
                                <EyeOff />
                                {t('review.ignoreExtension', { ext })}
                              </DropdownMenuItem>
                            );
                          })()}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => handleCopyPath(f.path, false)}>
                            <Copy />
                            {t('review.copyFilePath')}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleCopyPath(f.path, true)}>
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

          {/* Commit controls */}
          {summaries.length > 0 && commitInProgress && (
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
              <input
                type="text"
                placeholder={t('review.commitTitle')}
                aria-label={t('review.commitTitle', 'Commit title')}
                data-testid="review-commit-title"
                value={commitTitle}
                onChange={(e) => setCommitTitle(e.target.value)}
                disabled={!!actionInProgress || generatingMsg}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <div className="rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring">
                <textarea
                  className="w-full resize-none bg-transparent px-2 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none"
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
                        <Sparkles className={cn('h-2.5 w-2.5', generatingMsg && 'animate-pulse')} />
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
                  isOnDifferentBranch ? 'grid-cols-5' : 'grid-cols-3',
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
                  ...(isOnDifferentBranch
                    ? [
                        {
                          value: 'commit-pr' as const,
                          icon: GitPullRequest,
                          label: t('review.commitAndCreatePR', 'Commit & Create PR'),
                          testId: 'review-action-commit-pr',
                        },
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
                        disabled={!!actionInProgress || (!!isAgentRunning && !effectiveThreadId)}
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
                          className={cn('h-4 w-4', selectedAction === value && 'text-primary')}
                        />
                        <span className="text-[10px] font-medium leading-tight">{label}</span>
                      </button>
                    </TooltipTrigger>
                    {isAgentRunning && (
                      <TooltipContent side="top">{t('review.agentRunningTooltip')}</TooltipContent>
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
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : null}
                        {t('review.continue', 'Continue')}
                      </Button>
                    </div>
                  </TooltipTrigger>
                  {isAgentRunning && (
                    <TooltipContent side="top">{t('review.agentRunningTooltip')}</TooltipContent>
                  )}
                </Tooltip>
              </div>
            </div>
          )}

          {/* Standalone push button — shown when no dirty files but there are unpushed commits */}
          {showPushOnly && (
            <div className="flex-shrink-0 space-y-2 border-t border-sidebar-border p-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Upload className="h-3.5 w-3.5" />
                <span>
                  {t('review.readyToPush', {
                    count: gitStatus!.unpushedCommitCount,
                    defaultValue: `${gitStatus!.unpushedCommitCount} commit(s) ready to push`,
                  })}
                </span>
              </div>
              <div className="flex gap-1.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="flex-1">
                      <Button
                        className="w-full"
                        size="sm"
                        onClick={handlePushOnly}
                        disabled={pushInProgress || !!isAgentRunning}
                        data-testid="review-push"
                      >
                        {pushInProgress ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Upload className="mr-1.5 h-3.5 w-3.5" />
                        )}
                        {t('review.pushToOrigin', 'Push to origin')}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  {isAgentRunning && (
                    <TooltipContent side="top">{t('review.agentRunningTooltip')}</TooltipContent>
                  )}
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleResetSoft}
                      disabled={resetInProgress || !!isAgentRunning}
                      data-testid="review-undo-commit"
                    >
                      {resetInProgress ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {isAgentRunning
                      ? t('review.agentRunningTooltip')
                      : t('review.undoLastCommit', 'Undo last commit')}
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
          )}

          {/* Stash pop — shown when no dirty files but there are stashed changes */}
          {summaries.length === 0 && !loading && stashEntries.length > 0 && (
            <div className="flex-shrink-0 space-y-3 border-t border-sidebar-border p-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <ArchiveRestore className="h-3.5 w-3.5" />
                <span>
                  {t('review.stashedChanges', {
                    count: stashEntries.length,
                    defaultValue: `${stashEntries.length} stash(es) saved`,
                  })}
                </span>
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    className="w-full"
                    size="sm"
                    variant="outline"
                    onClick={handleStashPop}
                    disabled={stashPopInProgress || !!isAgentRunning}
                    data-testid="review-pop-stash"
                  >
                    {stashPopInProgress ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ArchiveRestore className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    {t('review.popStash', 'Pop stash')}
                  </Button>
                </TooltipTrigger>
                {isAgentRunning && (
                  <TooltipContent side="top">{t('review.agentRunningTooltip')}</TooltipContent>
                )}
              </Tooltip>
            </div>
          )}

          {/* Standalone merge / create PR buttons — shown when no dirty files but worktree has unmerged commits */}
          {showMergeOnly && (
            <div className="flex-shrink-0 space-y-3 border-t border-sidebar-border p-3">
              {commitInProgress && commitEntry?.action === 'merge' ? (
                <>
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
                          }}
                          data-testid="review-merge-dismiss"
                        >
                          {t('review.progress.dismiss', 'Dismiss')}
                        </Button>
                      );
                    }
                    return null;
                  })()}
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <GitMerge className="h-3.5 w-3.5" />
                    <span>
                      {t('review.readyToMerge', {
                        target: baseBranch || 'base',
                        defaultValue: `Ready to merge into ${baseBranch || 'base'}`,
                      })}
                    </span>
                  </div>
                  <div className="flex gap-1.5">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          className="flex-1"
                          size="sm"
                          onClick={handleMergeOnly}
                          disabled={mergeInProgress || (!!isAgentRunning && !effectiveThreadId)}
                          data-testid="review-merge"
                        >
                          {mergeInProgress ? (
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <GitMerge className="mr-1.5 h-3.5 w-3.5" />
                          )}
                          {t('review.mergeIntoBranch', {
                            target: baseBranch || 'base',
                            defaultValue: `Merge into ${baseBranch || 'base'}`,
                          })}
                        </Button>
                      </TooltipTrigger>
                      {isAgentRunning && (
                        <TooltipContent side="top">
                          {t('review.agentRunningTooltip')}
                        </TooltipContent>
                      )}
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setPrDialog({ title: threadBranch || '', body: '' })}
                          disabled={!!isAgentRunning}
                          data-testid="review-create-pr"
                        >
                          <GitPullRequest className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        {isAgentRunning
                          ? t('review.agentRunningTooltip')
                          : t('review.createPRTooltip', {
                              branch: threadBranch,
                              target: baseBranch || 'base',
                            })}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Rebase conflict resolution — shown when merge/rebase failed with conflicts */}
          {hasRebaseConflict && (
            <div className="flex-shrink-0 space-y-2 border-t border-sidebar-border p-3">
              <div className="flex items-center gap-2 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" />
                <span>{t('review.mergeConflict', { target: baseBranch || 'main' })}</span>
              </div>
              {isWorktree && (
                <Button
                  className="w-full"
                  size="sm"
                  variant="outline"
                  onClick={handleOpenInEditorConflict}
                >
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                  {t('review.openInEditor', {
                    editor: editorLabels[useSettingsStore.getState().defaultEditor],
                  })}
                </Button>
              )}
              <Button className="w-full" size="sm" onClick={handleAskAgentResolve}>
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                {t('review.askAgentResolve')}
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Confirmation dialog for destructive actions */}
      <ConfirmDialog
        open={!!confirmDialog}
        onOpenChange={(open) => {
          if (!open) setConfirmDialog(null);
        }}
        title={
          confirmDialog?.type === 'revert' || confirmDialog?.type === 'discard-all'
            ? t('review.discardChanges', 'Discard changes')
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
          }
        }}
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
              {t('review.createPRTooltip', { branch: threadBranch, target: baseBranch || 'base' })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <input
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder={t('review.prTitle', 'PR title')}
              data-testid="review-pr-title"
              value={prDialog?.title ?? ''}
              onChange={(e) =>
                setPrDialog((prev) => (prev ? { ...prev, title: e.target.value } : prev))
              }
            />
            <textarea
              className="w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
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
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <GitPullRequest className="mr-1.5 h-3.5 w-3.5" />
              )}
              {t('review.createPR')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Expanded diff modal */}
      <Dialog
        open={!!expandedFile}
        onOpenChange={(open) => {
          if (!open) setExpandedFile(null);
        }}
      >
        <DialogContent className="flex h-[85vh] w-[90vw] max-w-[90vw] flex-col gap-0 p-0">
          {(() => {
            if (!expandedFile) return null;
            const expandedSummary = summaries.find((s) => s.path === expandedFile);
            if (!expandedSummary) return null;
            const expandedDiffContent = diffCache.get(expandedFile);
            const Icon = fileStatusIcons[expandedSummary.status] || FileCode;
            return (
              <>
                <DialogHeader className="flex-shrink-0 overflow-hidden border-b border-border px-4 py-3 pr-10">
                  <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                    <Icon className="h-4 w-4 flex-shrink-0" />
                    <DialogTitle
                      className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-sm"
                      style={{ direction: 'rtl', textAlign: 'left' }}
                    >
                      {expandedSummary.path}
                    </DialogTitle>
                  </div>
                  <DialogDescription className="sr-only">
                    {t('review.diffFor', {
                      file: expandedSummary.path,
                      defaultValue: `Diff for ${expandedSummary.path}`,
                    })}
                  </DialogDescription>
                </DialogHeader>
                <ScrollArea className="min-h-0 flex-1">
                  {loadingDiff === expandedFile ? (
                    <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading diff\u2026
                    </div>
                  ) : expandedDiffContent ? (
                    <div className="[&_.diff-container]:font-mono [&_table]:w-full [&_td]:overflow-hidden [&_td]:text-ellipsis">
                      <Suspense
                        fallback={
                          <div className="p-4 text-sm text-muted-foreground">
                            Loading diff\u2026
                          </div>
                        }
                      >
                        <MemoizedDiffView diff={expandedDiffContent} splitView={true} />
                      </Suspense>
                    </div>
                  ) : (
                    <p className="p-4 text-sm text-muted-foreground">
                      {t('review.binaryOrNoDiff')}
                    </p>
                  )}
                  <ScrollBar orientation="horizontal" />
                </ScrollArea>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
