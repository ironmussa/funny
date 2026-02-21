import { useState, useEffect, useRef, useMemo, useCallback, memo, Suspense } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';
import { useAppStore } from '@/stores/app-store';
import { useSettingsStore, deriveToolLists } from '@/stores/settings-store';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { ReactDiffViewer, DIFF_VIEWER_STYLES } from './tool-cards/utils';
import { toEditorUri, openFileInEditor, getEditorLabel } from '@/lib/editor-utils';
import { editorLabels } from '@/stores/settings-store';
import { Button } from '@/components/ui/button';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { useAutoRefreshDiff } from '@/hooks/use-auto-refresh-diff';
import { useGitStatusStore } from '@/stores/git-status-store';
import { useDraftStore } from '@/stores/draft-store';
import { getNavigate } from '@/stores/thread-store-internals';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
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
  MoreHorizontal,
  Undo2,
  EyeOff,
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
} from 'lucide-react';
import type { FileDiffSummary } from '@funny/shared';

const fileStatusIcons: Record<string, typeof FileCode> = {
  added: FilePlus,
  modified: FileCode,
  deleted: FileX,
  renamed: FileCode,
};

const FILE_ROW_HEIGHT = 28;

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

const MemoizedDiffView = memo(function MemoizedDiffView({ diff, splitView = false }: { diff: string; splitView?: boolean }) {
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
      styles={DIFF_VIEWER_STYLES}
      codeFoldMessageRenderer={() => <></>}
    />
  );
});

export function ReviewPane() {
  const { t } = useTranslation();
  const setReviewPaneOpen = useUIStore(s => s.setReviewPaneOpen);
  const selectedProjectId = useProjectStore(s => s.selectedProjectId);

  // Derive effectiveThreadId from the active thread only.
  // Never fall back to the first thread in the project list — that can return
  // a worktree thread when the user selected a local (master) thread, causing
  // the review pane to show diff data from the wrong working directory.
  const effectiveThreadId = useThreadStore(s => s.activeThread?.id);

  // The base directory path for constructing absolute file paths (worktree path or project path)
  const basePath = useThreadStore(s => {
    const wt = s.activeThread?.worktreePath;
    if (wt) return wt;
    const pid = s.activeThread?.projectId ?? selectedProjectId;
    if (!pid) return '';
    return useProjectStore.getState().projects.find(p => p.id === pid)?.path ?? '';
  });

  const [summaries, setSummaries] = useState<FileDiffSummary[]>([]);
  const [diffCache, setDiffCache] = useState<Map<string, string>>(new Map());
  const [loadingDiff, setLoadingDiff] = useState<string | null>(null);
  const [truncatedInfo, setTruncatedInfo] = useState<{ total: number; truncated: boolean }>({ total: 0, truncated: false });
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [fileSearch, setFileSearch] = useState('');
  const [checkedFiles, setCheckedFiles] = useState<Set<string>>(new Set());
  const { setCommitDraft, clearCommitDraft } = useDraftStore();
  const [commitTitle, setCommitTitleRaw] = useState('');
  const [commitBody, setCommitBodyRaw] = useState('');

  // Wrap setters to also persist to draft store
  const setCommitTitle = useCallback((v: string | ((prev: string) => string)) => {
    setCommitTitleRaw(prev => {
      const next = typeof v === 'function' ? v(prev) : v;
      if (effectiveThreadId) {
        // Read current body from state for sync
        setCommitBodyRaw(body => {
          setCommitDraft(effectiveThreadId, next, body);
          return body;
        });
      }
      return next;
    });
  }, [effectiveThreadId, setCommitDraft]);

  const setCommitBody = useCallback((v: string | ((prev: string) => string)) => {
    setCommitBodyRaw(prev => {
      const next = typeof v === 'function' ? v(prev) : v;
      if (effectiveThreadId) {
        setCommitTitleRaw(title => {
          setCommitDraft(effectiveThreadId, title, next);
          return title;
        });
      }
      return next;
    });
  }, [effectiveThreadId, setCommitDraft]);
  const [generatingMsg, setGeneratingMsg] = useState(false);
  const [selectedAction, setSelectedAction] = useState<'commit' | 'commit-push' | 'commit-pr' | 'commit-merge' | 'amend'>('commit');
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  // New git operations state
  const [logEntries, setLogEntries] = useState<Array<{ hash: string; shortHash: string; author: string; relativeDate: string; message: string }>>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [logLoading, setLogLoading] = useState(false);
  const [pullInProgress, setPullInProgress] = useState(false);
  const [stashInProgress, setStashInProgress] = useState(false);
  const [stashEntries, setStashEntries] = useState<Array<{ index: string; message: string; relativeDate: string }>>([]);
  const [stashPopInProgress, setStashPopInProgress] = useState(false);
  const [resetInProgress, setResetInProgress] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{ type: 'revert' | 'reset'; path?: string } | null>(null);

  const isWorktree = useThreadStore(s => s.activeThread?.mode === 'worktree');
  const baseBranch = useThreadStore(s => s.activeThread?.baseBranch);
  const threadBranch = useThreadStore(s => s.activeThread?.branch);
  const hasWorktreePath = useThreadStore(s => !!s.activeThread?.worktreePath);
  const isAgentRunning = useThreadStore(s => s.activeThread?.status === 'running');
  const gitStatus = useGitStatusStore(s => effectiveThreadId ? s.statusByThread[effectiveThreadId] : undefined);
  const [mergeInProgress, setMergeInProgress] = useState(false);
  const [pushInProgress, setPushInProgress] = useState(false);
  const [hasRebaseConflict, setHasRebaseConflict] = useState(false);

  // Show standalone merge button when worktree has no dirty files but has unmerged commits.
  // Also require the worktree to actually exist (has a path) and the branch to differ from baseBranch.
  const showMergeOnly = isWorktree && hasWorktreePath && summaries.length === 0 && !loading && gitStatus && !gitStatus.isMergedIntoBase && !hasRebaseConflict && (!baseBranch || threadBranch !== baseBranch);

  // Show standalone push button when no dirty files but there are unpushed commits
  const showPushOnly = summaries.length === 0 && !loading && gitStatus && gitStatus.unpushedCommitCount > 0 && !hasRebaseConflict;

  const showMergeConflictToast = useCallback((errorMessage: string, _threadId: string) => {
    const target = baseBranch || 'main';
    const lower = errorMessage.toLowerCase();
    const isConflict = lower.includes('conflict') ||
                       lower.includes('rebase failed') ||
                       lower.includes('merge failed') ||
                       lower.includes('automatic merge failed') ||
                       lower.includes('fix conflicts') ||
                       lower.includes('could not apply');

    if (!isConflict) {
      toast.error(t('review.mergeFailed', { message: errorMessage }));
      return;
    }

    toast.error(t('review.mergeConflict', { target }));
    setHasRebaseConflict(true);
  }, [t, baseBranch]);

  const fileListRef = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    if (!effectiveThreadId) return;
    setLoading(true);
    const result = await api.getDiffSummary(effectiveThreadId);
    if (result.isOk()) {
      const data = result.value;
      setSummaries(data.files);
      setTruncatedInfo({ total: data.total, truncated: data.truncated });
      setDiffCache(new Map());
      // Check all files by default, preserving existing selections
      setCheckedFiles(prev => {
        const next = new Set(prev);
        for (const f of data.files) {
          if (!prev.has(f.path) && prev.size === 0) {
            next.add(f.path);
          } else if (!prev.has(f.path) && data.files.length > prev.size) {
            next.add(f.path);
          }
        }
        for (const p of prev) {
          if (!data.files.find(d => d.path === p)) next.delete(p);
        }
        return next.size === 0 ? new Set(data.files.map(d => d.path)) : next;
      });
      if (data.files.length > 0 && !selectedFile) {
        setSelectedFile(data.files[0].path);
      }
      // Re-load diff for the currently selected file after cache was cleared
      const fileToLoad = selectedFile ?? (data.files.length > 0 ? data.files[0].path : null);
      if (fileToLoad) {
        const summary = data.files.find(s => s.path === fileToLoad);
        if (summary) {
          setLoadingDiff(fileToLoad);
          const diffResult = await api.getFileDiff(effectiveThreadId, fileToLoad, summary.staged);
          if (diffResult.isOk()) {
            setDiffCache(prev => new Map(prev).set(fileToLoad, diffResult.value.diff));
          }
          setLoadingDiff(prev => prev === fileToLoad ? null : prev);
        }
      }
    } else {
      console.error('Failed to load diff summary:', result.error);
    }
    setLoading(false);
    // Also refresh git status so we know if there are unmerged commits
    if (effectiveThreadId) useGitStatusStore.getState().fetchForThread(effectiveThreadId);
  };

  // Lazy load diff content for the selected file
  const loadDiffForFile = async (filePath: string) => {
    if (!effectiveThreadId || diffCache.has(filePath)) return;
    const summary = summaries.find(s => s.path === filePath);
    if (!summary) return;
    setLoadingDiff(filePath);
    const result = await api.getFileDiff(effectiveThreadId, filePath, summary.staged);
    if (result.isOk()) {
      setDiffCache(prev => new Map(prev).set(filePath, result.value.diff));
    }
    setLoadingDiff(prev => prev === filePath ? null : prev);
  };

  // Load diff when selected file or expanded file changes
  useEffect(() => {
    if (selectedFile && !diffCache.has(selectedFile)) {
      loadDiffForFile(selectedFile);
    }
  }, [selectedFile]);

  useEffect(() => {
    if (expandedFile && !diffCache.has(expandedFile)) {
      loadDiffForFile(expandedFile);
    }
  }, [expandedFile]);

  // Reset state and refresh when the active thread changes.
  // Using effectiveThreadId (not just gitContextKey) ensures we refresh even
  // when switching between two local threads of the same project that share
  // the same git working directory.
  useEffect(() => {
    setSummaries([]);
    setDiffCache(new Map());
    setSelectedFile(null);
    setCheckedFiles(new Set());
    setFileSearch('');
    setHasRebaseConflict(false);
    setSelectedAction('commit');

    // Restore commit title/body from draft store
    const draft = effectiveThreadId ? useDraftStore.getState().drafts[effectiveThreadId] : undefined;
    setCommitTitleRaw(draft?.commitTitle ?? '');
    setCommitBodyRaw(draft?.commitBody ?? '');

    refresh();
  }, [effectiveThreadId]);

  // Auto-refresh diffs when agent modifies files (debounced 2s)
  useAutoRefreshDiff(effectiveThreadId, refresh, 2000);

  const filteredDiffs = useMemo(() => {
    if (!fileSearch) return summaries;
    const query = fileSearch.toLowerCase();
    return summaries.filter(d => d.path.toLowerCase().includes(query));
  }, [summaries, fileSearch]);

  const selectedDiffContent = selectedFile ? diffCache.get(selectedFile) : undefined;

  const checkedCount = checkedFiles.size;
  const totalCount = summaries.length;

  const virtualizer = useVirtualizer({
    count: filteredDiffs.length,
    getScrollElement: () => fileListRef.current,
    estimateSize: () => FILE_ROW_HEIGHT,
    overscan: 15,
  });

  const toggleFile = (path: string) => {
    setCheckedFiles(prev => {
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
      setCheckedFiles(new Set(summaries.map(d => d.path)));
    }
  };

  const handleGenerateCommitMsg = async () => {
    if (!effectiveThreadId || generatingMsg) return;
    setGeneratingMsg(true);
    const result = await api.generateCommitMessage(effectiveThreadId, true);
    if (result.isOk()) {
      setCommitTitle(result.value.title);
      setCommitBody(result.value.body);
    } else {
      toast.error(t('review.generateFailed', { message: result.error.message }));
    }
    setGeneratingMsg(false);
  };

  const performCommit = async (): Promise<boolean> => {
    if (!effectiveThreadId || !commitTitle.trim() || checkedFiles.size === 0) return false;
    const commitMsg = commitBody.trim()
      ? `${commitTitle.trim()}\n\n${commitBody.trim()}`
      : commitTitle.trim();

    // Only unstage files that are staged but NOT selected (avoid unstage→restage
    // cycle which breaks gitignored files that were previously force-staged)
    const toUnstage = summaries
      .filter(f => f.staged && !checkedFiles.has(f.path))
      .map(f => f.path);
    if (toUnstage.length > 0) {
      const unstageResult = await api.unstageFiles(effectiveThreadId, toUnstage);
      if (unstageResult.isErr()) {
        toast.error(t('review.unstageFailed', { message: unstageResult.error.message }));
        return false;
      }
    }

    // Only stage files that are selected but NOT already staged
    const toStage = Array.from(checkedFiles).filter(p => {
      const s = summaries.find(f => f.path === p);
      return s && !s.staged;
    });
    if (toStage.length > 0) {
      const stageResult = await api.stageFiles(effectiveThreadId, toStage);
      if (stageResult.isErr()) {
        toast.error(t('review.stageFailed', { message: stageResult.error.message }));
        return false;
      }
    }

    const isAmend = selectedAction === 'amend';
    const result = await api.commit(effectiveThreadId, commitMsg, isAmend);
    if (result.isErr()) {
      toast.error(t('review.commitFailed', { message: result.error.message }));
      return false;
    }
    return true;
  };

  const handleCommitAction = async () => {
    if (!effectiveThreadId || !commitTitle.trim() || checkedFiles.size === 0 || actionInProgress) return;
    setActionInProgress(selectedAction);

    const commitSuccess = await performCommit();
    if (!commitSuccess) {
      setActionInProgress(null);
      return;
    }

    if (selectedAction === 'commit' || selectedAction === 'amend') {
      toast.success(selectedAction === 'amend' ? t('review.amendSuccess', 'Commit amended') : t('review.commitSuccess'));
    } else if (selectedAction === 'commit-push') {
      const pushResult = await api.push(effectiveThreadId);
      if (pushResult.isErr()) {
        toast.error(t('review.pushFailed', { message: pushResult.error.message }));
      } else {
        toast.success(t('review.pushedSuccess'));
      }
    } else if (selectedAction === 'commit-pr') {
      const pushResult = await api.push(effectiveThreadId);
      if (pushResult.isErr()) {
        toast.error(t('review.pushFailed', { message: pushResult.error.message }));
        setActionInProgress(null);
        await refresh();
        return;
      }
      const prResult = await api.createPR(effectiveThreadId, commitTitle.trim(), commitBody.trim());
      if (prResult.isErr()) {
        toast.error(t('review.prFailed', { message: prResult.error.message }));
      } else if (prResult.value.url) {
        toast.success(
          <div>
            {t('review.prCreated')}
            <a href={prResult.value.url} target="_blank" rel="noopener noreferrer" className="underline ml-2">
              View PR
            </a>
          </div>
        );
      } else {
        toast.success(t('review.prCreated'));
      }
    } else if (selectedAction === 'commit-merge') {
      const mergeResult = await api.merge(effectiveThreadId, { cleanup: true });
      if (mergeResult.isErr()) {
        showMergeConflictToast(mergeResult.error.message, effectiveThreadId);
        setActionInProgress(null);
        await refresh();
        return;
      }
      const target = useThreadStore.getState().activeThread?.baseBranch || 'base';
      toast.success(t('review.commitAndMergeSuccess', { target }));
      // Refresh thread data so mode/branch/worktreePath reflect the cleanup
      await useThreadStore.getState().refreshActiveThread();
    }

    setCommitTitleRaw('');
    setCommitBodyRaw('');
    if (effectiveThreadId) clearCommitDraft(effectiveThreadId);
    setActionInProgress(null);
    await refresh();
  };

  const handleRevertFile = (path: string) => {
    setConfirmDialog({ type: 'revert', path });
  };

  const executeRevert = async (path: string) => {
    if (!effectiveThreadId) return;
    const result = await api.revertFiles(effectiveThreadId, [path]);
    if (result.isErr()) {
      toast.error(t('review.revertFailed', { message: result.error.message }));
    } else {
      await refresh();
    }
  };

  const handleIgnore = async (pattern: string) => {
    if (!effectiveThreadId) return;
    const result = await api.addToGitignore(effectiveThreadId, pattern);
    if (result.isErr()) {
      toast.error(t('review.ignoreFailed', { message: result.error.message }));
    } else {
      toast.success(t('review.ignoreSuccess'));
      await refresh();
    }
  };

  const handlePushOnly = async () => {
    if (!effectiveThreadId || pushInProgress) return;
    setPushInProgress(true);
    const pushResult = await api.push(effectiveThreadId);
    if (pushResult.isErr()) {
      toast.error(t('review.pushFailed', { message: pushResult.error.message }));
    } else {
      toast.success(t('review.pushedSuccess'));
    }
    setPushInProgress(false);
    useGitStatusStore.getState().fetchForThread(effectiveThreadId);
  };

  const handleMergeOnly = async () => {
    if (!effectiveThreadId || mergeInProgress) return;
    setMergeInProgress(true);
    const mergeResult = await api.merge(effectiveThreadId, { cleanup: true });
    if (mergeResult.isErr()) {
      showMergeConflictToast(mergeResult.error.message, effectiveThreadId);
    } else {
      const target = baseBranch || 'base';
      const branch = useThreadStore.getState().activeThread?.branch || '';
      toast.success(t('review.mergeSuccess', { branch, target, defaultValue: `Merged "${branch}" into "${target}" successfully` }));
      // Refresh thread data so mode/branch/worktreePath reflect the cleanup
      await useThreadStore.getState().refreshActiveThread();
    }
    setMergeInProgress(false);
    useGitStatusStore.getState().fetchForThread(effectiveThreadId);
  };

  const handleAskAgentResolve = async () => {
    if (!effectiveThreadId) return;

    const activeThread = useThreadStore.getState().activeThread;
    if (!activeThread) return;

    const target = baseBranch || 'main';
    const prompt = t('review.agentResolvePrompt', { target });
    const title = t('review.agentResolveThreadTitle', { target });
    const { allowedTools, disallowedTools } = deriveToolLists(
      useSettingsStore.getState().toolPermissions
    );

    const result = await api.createThread({
      projectId: activeThread.projectId,
      title,
      mode: 'local',
      prompt,
      allowedTools,
      disallowedTools,
      worktreePath: activeThread.worktreePath ?? undefined,
    });

    if (result.isErr()) {
      toast.error(result.error.message);
      return;
    }

    const newThread = result.value;
    await useThreadStore.getState().loadThreadsForProject(activeThread.projectId);

    const navigate = getNavigate();
    if (navigate) {
      navigate(`/projects/${activeThread.projectId}/threads/${newThread.id}`);
    }

    useUIStore.getState().setReviewPaneOpen(false);
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
    if (!effectiveThreadId || logLoading) return;
    setLogLoading(true);
    const result = await api.getGitLog(effectiveThreadId, 20);
    if (result.isOk()) {
      setLogEntries(result.value.entries);
    } else {
      toast.error(t('review.logFailed', { message: result.error.message, defaultValue: `Failed to load log: ${result.error.message}` }));
    }
    setLogLoading(false);
  };

  const handlePull = async () => {
    if (!effectiveThreadId || pullInProgress) return;
    setPullInProgress(true);
    const result = await api.pull(effectiveThreadId);
    if (result.isErr()) {
      toast.error(t('review.pullFailed', { message: result.error.message, defaultValue: `Pull failed: ${result.error.message}` }));
    } else {
      toast.success(t('review.pullSuccess', 'Pulled successfully'));
    }
    setPullInProgress(false);
    await refresh();
  };

  const handleStash = async () => {
    if (!effectiveThreadId || stashInProgress) return;
    setStashInProgress(true);
    const result = await api.stash(effectiveThreadId);
    if (result.isErr()) {
      toast.error(t('review.stashFailed', { message: result.error.message, defaultValue: `Stash failed: ${result.error.message}` }));
    } else {
      toast.success(t('review.stashSuccess', 'Changes stashed'));
    }
    setStashInProgress(false);
    await refresh();
    refreshStashList();
  };

  const handleStashPop = async () => {
    if (!effectiveThreadId || stashPopInProgress) return;
    setStashPopInProgress(true);
    const result = await api.stashPop(effectiveThreadId);
    if (result.isErr()) {
      toast.error(t('review.stashPopFailed', { message: result.error.message, defaultValue: `Stash pop failed: ${result.error.message}` }));
    } else {
      toast.success(t('review.stashPopSuccess', 'Stash applied'));
    }
    setStashPopInProgress(false);
    await refresh();
    refreshStashList();
  };

  const refreshStashList = async () => {
    if (!effectiveThreadId) return;
    const result = await api.stashList(effectiveThreadId);
    if (result.isOk()) {
      setStashEntries(result.value.entries);
    }
  };

  const handleResetSoft = () => {
    setConfirmDialog({ type: 'reset' });
  };

  const executeResetSoft = async () => {
    if (!effectiveThreadId || resetInProgress) return;
    setResetInProgress(true);
    const result = await api.resetSoft(effectiveThreadId);
    if (result.isErr()) {
      toast.error(t('review.resetSoftFailed', { message: result.error.message, defaultValue: `Reset failed: ${result.error.message}` }));
    } else {
      toast.success(t('review.resetSoftSuccess', 'Last commit undone'));
    }
    setResetInProgress(false);
    await refresh();
  };

  // Load stash list on mount / thread change
  useEffect(() => {
    refreshStashList();
  }, [effectiveThreadId]);

  const canCommit = checkedFiles.size > 0 && commitTitle.trim().length > 0 && !actionInProgress && !isAgentRunning;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-sidebar-border">
        <div className="flex items-center gap-1">
          <h3 className="text-xs font-semibold text-sidebar-foreground uppercase tracking-wider mr-1">{t('review.title')}</h3>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={refresh}
                className="text-muted-foreground"
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
              >
                <Download className={cn('h-3.5 w-3.5', pullInProgress && 'animate-pulse')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t('review.pull', 'Pull')}</TooltipContent>
          </Tooltip>
          <Popover open={logOpen} onOpenChange={(open) => { setLogOpen(open); if (open) handleLoadLog(); }}>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground"
                  >
                    <History className="h-3.5 w-3.5" />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent side="top">{t('review.log', 'Commit log')}</TooltipContent>
            </Tooltip>
            <PopoverContent align="start" className="w-[400px] p-0 max-h-[360px] overflow-auto">
              {logLoading ? (
                <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t('review.loadingLog', 'Loading commits\u2026')}
                </div>
              ) : logEntries.length === 0 ? (
                <p className="text-xs text-muted-foreground p-3">{t('review.noCommits', 'No commits yet')}</p>
              ) : (
                <div className="divide-y divide-border">
                  {logEntries.map((entry) => (
                    <div key={entry.hash} className="px-3 py-2 text-xs hover:bg-accent/50">
                      <div className="flex items-center gap-2">
                        <code className="text-[10px] text-primary font-mono">{entry.shortHash}</code>
                        <span className="text-muted-foreground">{entry.relativeDate}</span>
                      </div>
                      <p className="mt-0.5 text-foreground truncate">{entry.message}</p>
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
                >
                  <Archive className={cn('h-3.5 w-3.5', stashInProgress && 'animate-pulse')} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{isAgentRunning ? t('review.agentRunningTooltip') : t('review.stash', 'Stash changes')}</TooltipContent>
            </Tooltip>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setReviewPaneOpen(false)}
              className="text-muted-foreground"
            >
              <PanelRightClose className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{t('review.close', 'Close')}</TooltipContent>
        </Tooltip>
      </div>

      {/* Two-column layout: diff left, files right */}
      <div className="flex-1 flex min-h-0">
        {/* Left: Diff viewer */}
        <div className="flex-1 min-w-0 flex flex-col">
          <ScrollArea className="flex-1 w-full">
            {selectedFile ? (
              loadingDiff === selectedFile ? (
                <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading diff\u2026
                </div>
              ) : selectedDiffContent ? (
                <div className="relative text-xs [&_.diff-container]:font-mono [&_.diff-container]:text-sm [&_table]:w-max [&_td:last-child]:w-auto [&_td:last-child]:min-w-0">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="secondary"
                        size="icon-xs"
                        onClick={() => setExpandedFile(selectedFile)}
                        className="sticky top-2 right-2 z-10 opacity-70 hover:opacity-100 shadow-md float-right mr-2 mt-2"
                      >
                        <Maximize2 className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="left">{t('review.expand', 'Expand')}</TooltipContent>
                  </Tooltip>
                  <Suspense fallback={<div className="p-2 text-xs text-muted-foreground">Loading diff\u2026</div>}>
                    <MemoizedDiffView diff={selectedDiffContent} />
                  </Suspense>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground p-2">{t('review.binaryOrNoDiff')}</p>
              )
            ) : (
              <p className="text-xs text-muted-foreground p-2">{t('review.selectFile')}</p>
            )}
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        </div>

        {/* Right: File list panel */}
        <div className="w-[352px] flex-shrink-0 border-l border-sidebar-border flex flex-col">
          {/* Truncation warning */}
          {truncatedInfo.truncated && (
            <div className="px-3 py-1.5 bg-yellow-500/10 border-b border-sidebar-border text-xs text-yellow-600 dark:text-yellow-400">
              {t('review.truncatedWarning', {
                shown: summaries.length,
                total: truncatedInfo.total,
                defaultValue: `Showing ${summaries.length} of ${truncatedInfo.total} files. Some files were excluded.`,
              })}
            </div>
          )}

          {/* File search */}
          {summaries.length > 0 && (
            <div className="px-2 py-2 border-b border-sidebar-border">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  type="text"
                  placeholder={t('review.searchFiles', 'Filter files\u2026')}
                  aria-label={t('review.searchFiles', 'Filter files')}
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
            <div className="flex items-center gap-1.5 px-4 py-1.5 border-b border-sidebar-border">
              <button
                role="checkbox"
                aria-checked={checkedFiles.size === summaries.length ? true : checkedFiles.size > 0 ? 'mixed' : false}
                aria-label={t('review.selectAll', 'Select all files')}
                onClick={toggleAll}
                className={cn(
                  'flex items-center justify-center h-3.5 w-3.5 rounded border transition-colors flex-shrink-0',
                  checkedFiles.size === summaries.length
                    ? 'bg-primary border-primary text-primary-foreground'
                    : checkedFiles.size > 0
                      ? 'bg-primary/50 border-primary text-primary-foreground'
                      : 'border-muted-foreground/40'
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
          ) : summaries.length === 0 ? (
            <p className="text-xs text-muted-foreground p-3">{t('review.noChanges')}</p>
          ) : filteredDiffs.length === 0 ? (
            <p className="text-xs text-muted-foreground p-3">{t('review.noMatchingFiles', 'No matching files')}</p>
          ) : (
            <div ref={fileListRef} className="flex-1 overflow-auto">
              <div
                style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}
              >
                {virtualizer.getVirtualItems().map((virtualRow) => {
                  const f = filteredDiffs[virtualRow.index];
                  const isChecked = checkedFiles.has(f.path);
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
                      }}
                      className={cn(
                        'group flex items-center gap-1.5 px-4 text-xs cursor-pointer transition-colors',
                        selectedFile === f.path
                          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                          : 'hover:bg-sidebar-accent/50 text-muted-foreground'
                      )}
                      onClick={() => setSelectedFile(f.path)}
                    >
                      <button
                        role="checkbox"
                        aria-checked={isChecked}
                        aria-label={t('review.selectFile', { file: f.path, defaultValue: `Select ${f.path}` })}
                        onClick={(e) => { e.stopPropagation(); toggleFile(f.path); }}
                        className={cn(
                          'flex items-center justify-center h-3.5 w-3.5 rounded border transition-colors flex-shrink-0',
                          isChecked
                            ? 'bg-primary border-primary text-primary-foreground'
                            : 'border-muted-foreground/40'
                        )}
                      >
                        {isChecked && <Check className="h-2.5 w-2.5" />}
                      </button>
                      <span
                        className="flex-1 truncate font-mono text-[11px]"
                      >{f.path}</span>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            onClick={(e) => e.stopPropagation()}
                            aria-label={t('review.moreActions', 'More actions')}
                            className="flex items-center justify-center h-4 w-4 rounded text-muted-foreground hover:text-foreground transition-all flex-shrink-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
                          >
                            <MoreHorizontal className="h-3 w-3" />
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
                                    <DropdownMenuItem key={folder} onClick={() => handleIgnore(folder)}>
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
                      <span className={cn(
                        'text-[10px] font-medium flex-shrink-0',
                        f.status === 'added' && 'text-status-success',
                        f.status === 'modified' && 'text-status-pending',
                        f.status === 'deleted' && 'text-destructive',
                        f.status === 'renamed' && 'text-status-info',
                      )}>
                        {f.status === 'added' ? 'A' : f.status === 'modified' ? 'M' : f.status === 'deleted' ? 'D' : 'R'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Commit controls */}
          {summaries.length > 0 && (
            <div className="border-t border-sidebar-border p-2 space-y-1.5 flex-shrink-0">
              <input
                type="text"
                placeholder={t('review.commitTitle')}
                aria-label={t('review.commitTitle', 'Commit title')}
                value={commitTitle}
                onChange={(e) => setCommitTitle(e.target.value)}
                disabled={!!actionInProgress || generatingMsg}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <div className="rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring">
                <textarea
                  className="w-full px-2 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none resize-none bg-transparent"
                  rows={7}
                  aria-label={t('review.commitBody', 'Commit body')}
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
                      >
                        <Sparkles className={cn('h-2.5 w-2.5', generatingMsg && 'animate-pulse')} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {generatingMsg ? t('review.generatingCommitMsg') : t('review.generateCommitMsg')}
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
              <div className={cn('grid gap-1 mt-2', (isWorktree && hasWorktreePath) ? 'grid-cols-5' : 'grid-cols-3')}>
                {([
                  { value: 'commit' as const, icon: GitCommit, label: t('review.commit', 'Commit') },
                  { value: 'amend' as const, icon: PenLine, label: t('review.amend', 'Amend') },
                  { value: 'commit-push' as const, icon: Upload, label: t('review.commitAndPush', 'Commit & Push') },
                  ...((isWorktree && hasWorktreePath) ? [
                    { value: 'commit-pr' as const, icon: GitPullRequest, label: t('review.commitAndCreatePR', 'Commit & Create PR') },
                    { value: 'commit-merge' as const, icon: GitMerge, label: t('review.commitAndMerge', 'Commit & Merge') },
                  ] : []),
                ]).map(({ value, icon: ActionIcon, label }) => (
                  <Tooltip key={value}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => setSelectedAction(value)}
                        disabled={!!actionInProgress || !!isAgentRunning}
                        className={cn(
                          'flex flex-col items-center gap-1 rounded-md border p-2 text-center transition-all',
                          'hover:bg-accent/50 disabled:opacity-50 disabled:cursor-not-allowed',
                          selectedAction === value
                            ? 'border-primary bg-primary/5 text-foreground'
                            : 'border-border text-muted-foreground'
                        )}
                      >
                        <ActionIcon className={cn('h-4 w-4', selectedAction === value && 'text-primary')} />
                        <span className="text-[10px] font-medium leading-tight">{label}</span>
                      </button>
                    </TooltipTrigger>
                    {isAgentRunning && (
                      <TooltipContent side="top">{t('review.agentRunningTooltip')}</TooltipContent>
                    )}
                  </Tooltip>
                ))}
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="w-full">
                    <Button
                      className="w-full"
                      size="sm"
                      onClick={handleCommitAction}
                      disabled={!canCommit}
                    >
                      {actionInProgress ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
                      {t('review.continue', 'Continue')}
                    </Button>
                  </div>
                </TooltipTrigger>
                {isAgentRunning && (
                  <TooltipContent side="top">{t('review.agentRunningTooltip')}</TooltipContent>
                )}
              </Tooltip>
            </div>
          )}

          {/* Standalone push button — shown when no dirty files but there are unpushed commits */}
          {showPushOnly && (
            <div className="border-t border-sidebar-border p-3 flex-shrink-0 space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Upload className="h-3.5 w-3.5" />
                <span>{t('review.readyToPush', { count: gitStatus!.unpushedCommitCount, defaultValue: `${gitStatus!.unpushedCommitCount} commit(s) ready to push` })}</span>
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
                      >
                        {pushInProgress ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Upload className="h-3.5 w-3.5 mr-1.5" />}
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
                    >
                      {resetInProgress ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{isAgentRunning ? t('review.agentRunningTooltip') : t('review.undoLastCommit', 'Undo last commit')}</TooltipContent>
                </Tooltip>
              </div>
            </div>
          )}

          {/* Stash pop — shown when no dirty files but there are stashed changes */}
          {summaries.length === 0 && !loading && stashEntries.length > 0 && (
            <div className="border-t border-sidebar-border p-3 flex-shrink-0 space-y-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <ArchiveRestore className="h-3.5 w-3.5" />
                <span>{t('review.stashedChanges', { count: stashEntries.length, defaultValue: `${stashEntries.length} stash(es) saved` })}</span>
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                      className="w-full"
                      size="sm"
                      variant="outline"
                      onClick={handleStashPop}
                      disabled={stashPopInProgress || !!isAgentRunning}
                    >
                      {stashPopInProgress ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <ArchiveRestore className="h-3.5 w-3.5 mr-1.5" />}
                      {t('review.popStash', 'Pop stash')}
                    </Button>
                </TooltipTrigger>
                {isAgentRunning && (
                  <TooltipContent side="top">{t('review.agentRunningTooltip')}</TooltipContent>
                )}
              </Tooltip>
            </div>
          )}

          {/* Standalone merge button — shown when no dirty files but worktree has unmerged commits */}
          {showMergeOnly && (
            <div className="border-t border-sidebar-border p-3 flex-shrink-0 space-y-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <GitMerge className="h-3.5 w-3.5" />
                <span>{t('review.readyToMerge', { target: baseBranch || 'base', defaultValue: `Ready to merge into ${baseBranch || 'base'}` })}</span>
              </div>
              <Tooltip>
                <TooltipTrigger asChild>

                    <Button
                      className="w-full"
                      size="sm"
                      onClick={handleMergeOnly}
                      disabled={mergeInProgress || !!isAgentRunning}
                    >
                      {mergeInProgress ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <GitMerge className="h-3.5 w-3.5 mr-1.5" />}
                      {t('review.mergeIntoBranch', { target: baseBranch || 'base', defaultValue: `Merge into ${baseBranch || 'base'}` })}
                    </Button>
      
                </TooltipTrigger>
                {isAgentRunning && (
                  <TooltipContent side="top">{t('review.agentRunningTooltip')}</TooltipContent>
                )}
              </Tooltip>
            </div>
          )}

          {/* Rebase conflict resolution — shown when merge/rebase failed with conflicts */}
          {hasRebaseConflict && (
            <div className="border-t border-sidebar-border p-3 flex-shrink-0 space-y-2">
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
                  <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                  {t('review.openInEditor', { editor: editorLabels[useSettingsStore.getState().defaultEditor] })}
                </Button>
              )}
              <Button
                className="w-full"
                size="sm"
                onClick={handleAskAgentResolve}
              >
                <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                {t('review.askAgentResolve')}
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Confirmation dialog for destructive actions */}
      <Dialog open={!!confirmDialog} onOpenChange={(open) => { if (!open) setConfirmDialog(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {confirmDialog?.type === 'revert'
                ? t('review.discardChanges', 'Discard changes')
                : t('review.undoLastCommit', 'Undo last commit')}
            </DialogTitle>
            <DialogDescription>
              {confirmDialog?.type === 'revert'
                ? t('review.revertConfirm', { paths: confirmDialog?.path })
                : t('review.resetSoftConfirm', 'Undo the last commit? Changes will be kept.')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 mt-2">
            <Button variant="outline" size="sm" onClick={() => setConfirmDialog(null)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={async () => {
                const dialog = confirmDialog;
                setConfirmDialog(null);
                if (dialog?.type === 'revert' && dialog.path) {
                  await executeRevert(dialog.path);
                } else if (dialog?.type === 'reset') {
                  await executeResetSoft();
                }
              }}
            >
              {t('common.confirm', 'Confirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Expanded diff modal */}
      <Dialog open={!!expandedFile} onOpenChange={(open) => { if (!open) setExpandedFile(null); }}>
        <DialogContent className="max-w-[90vw] w-[90vw] h-[85vh] flex flex-col p-0 gap-0">
          {(() => {
            if (!expandedFile) return null;
            const expandedSummary = summaries.find(s => s.path === expandedFile);
            if (!expandedSummary) return null;
            const expandedDiffContent = diffCache.get(expandedFile);
            const Icon = fileStatusIcons[expandedSummary.status] || FileCode;
            return (
              <>
                <DialogHeader className="px-4 py-3 pr-10 border-b border-border flex-shrink-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <Icon className="h-4 w-4 flex-shrink-0" />
                    <DialogTitle className="font-mono text-sm truncate">{expandedSummary.path}</DialogTitle>
                  </div>
                  <DialogDescription className="sr-only">
                    {t('review.diffFor', { file: expandedSummary.path, defaultValue: `Diff for ${expandedSummary.path}` })}
                  </DialogDescription>
                </DialogHeader>
                <ScrollArea className="flex-1 min-h-0">
                  {loadingDiff === expandedFile ? (
                    <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading diff\u2026
                    </div>
                  ) : expandedDiffContent ? (
                    <div className="[&_.diff-container]:font-mono [&_table]:w-full [&_td]:overflow-hidden [&_td]:text-ellipsis">
                      <Suspense fallback={<div className="p-4 text-sm text-muted-foreground">Loading diff\u2026</div>}>
                        <MemoizedDiffView diff={expandedDiffContent} splitView={true} />
                      </Suspense>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground p-4">{t('review.binaryOrNoDiff')}</p>
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
