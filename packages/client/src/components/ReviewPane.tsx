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
    />
  );
});

export function ReviewPane() {
  const { t } = useTranslation();
  const setReviewPaneOpen = useUIStore(s => s.setReviewPaneOpen);
  const selectedProjectId = useProjectStore(s => s.selectedProjectId);

  // Derive effectiveThreadId with a stable selector that only returns a string,
  // avoiding re-renders when unrelated thread/store fields change.
  const effectiveThreadId = useThreadStore(s => {
    const threadId = s.activeThread?.id;
    if (threadId) return threadId;
    if (!selectedProjectId) return undefined;
    const threads = s.threadsByProject[selectedProjectId];
    return threads?.[0]?.id;
  });

  // The git context key identifies the working directory for diffs.
  // Worktree threads each have their own path; local threads share the project path.
  // Only reset/refresh when this actually changes (not on every thread switch).
  const gitContextKey = useThreadStore(s => {
    const wt = s.activeThread?.worktreePath;
    if (wt) return wt;
    // Local mode threads share the project directory — use projectId as key
    return s.activeThread?.projectId ?? selectedProjectId ?? '';
  });

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
  const [selectedAction, setSelectedAction] = useState<'commit' | 'commit-push' | 'commit-pr' | 'commit-merge'>('commit');
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  const isWorktree = useThreadStore(s => s.activeThread?.mode === 'worktree');
  const baseBranch = useThreadStore(s => s.activeThread?.baseBranch);
  const gitStatus = useGitStatusStore(s => effectiveThreadId ? s.statusByThread[effectiveThreadId] : undefined);
  const [mergeInProgress, setMergeInProgress] = useState(false);
  const [pushInProgress, setPushInProgress] = useState(false);

  // Show standalone merge button when worktree has no dirty files but has unmerged commits
  const showMergeOnly = isWorktree && summaries.length === 0 && !loading && gitStatus && !gitStatus.isMergedIntoBase;

  // Show standalone push button when no dirty files but there are unpushed commits
  const showPushOnly = summaries.length === 0 && !loading && gitStatus && gitStatus.unpushedCommitCount > 0;

  const showMergeConflictToast = useCallback((errorMessage: string, threadId: string) => {
    const target = baseBranch || 'main';
    const isConflict = errorMessage.toLowerCase().includes('conflict') ||
                       errorMessage.toLowerCase().includes('rebase failed');

    if (!isConflict) {
      toast.error(t('review.mergeFailed', { message: errorMessage }));
      return;
    }

    const worktreePath = useThreadStore.getState().activeThread?.worktreePath;

    toast.error(
      t('review.mergeConflict', { target }),
      {
        duration: 15000,
        action: {
          label: t('review.askAgentResolve'),
          onClick: () => {
            const prompt = t('review.agentResolvePrompt', { target });
            useAppStore.getState().appendOptimisticMessage(threadId, prompt);
            const { allowedTools, disallowedTools } = deriveToolLists(
              useSettingsStore.getState().toolPermissions
            );
            api.sendMessage(threadId, prompt, { allowedTools, disallowedTools });
            toast.success(t('review.agentResolveSent'));
          },
        },
        cancel: worktreePath ? {
          label: t('review.openInEditor', { editor: editorLabels[useSettingsStore.getState().defaultEditor] }),
          onClick: () => {
            const editor = useSettingsStore.getState().defaultEditor;
            api.openInEditor(worktreePath, editor);
          },
        } : undefined,
      }
    );
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

  // Reset state and refresh only when the git working directory changes.
  // Restore commit draft for the new thread if available.
  useEffect(() => {
    setSummaries([]);
    setDiffCache(new Map());
    setSelectedFile(null);
    setCheckedFiles(new Set());
    setFileSearch('');

    // Restore commit title/body from draft store
    const draft = effectiveThreadId ? useDraftStore.getState().drafts[effectiveThreadId] : undefined;
    setCommitTitleRaw(draft?.commitTitle ?? '');
    setCommitBodyRaw(draft?.commitBody ?? '');

    refresh();
  }, [gitContextKey]);

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

    const result = await api.commit(effectiveThreadId, commitMsg);
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

    if (selectedAction === 'commit') {
      toast.success(t('review.commitSuccess'));
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
    }

    setCommitTitleRaw('');
    setCommitBodyRaw('');
    if (effectiveThreadId) clearCommitDraft(effectiveThreadId);
    setActionInProgress(null);
    await refresh();
  };

  const handleRevertFile = async (path: string) => {
    if (!effectiveThreadId) return;
    const confirmed = window.confirm(t('review.revertConfirm', { paths: path }));
    if (!confirmed) return;
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
      toast.success(t('review.mergeSuccess', { target, defaultValue: `Merged into ${target} successfully` }));
    }
    setMergeInProgress(false);
    useGitStatusStore.getState().fetchForThread(effectiveThreadId);
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

  const canCommit = checkedFiles.size > 0 && commitTitle.trim().length > 0 && !actionInProgress;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-sidebar-border">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold text-sidebar-foreground uppercase tracking-wider">{t('review.title')}</h3>
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
                  Loading diff...
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
                  <Suspense fallback={<div className="p-2 text-xs text-muted-foreground">Loading diff...</div>}>
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
                  placeholder={t('review.searchFiles', 'Filter files...')}
                  value={fileSearch}
                  onChange={(e) => setFileSearch(e.target.value)}
                  className="h-7 pl-7 pr-7 text-xs md:text-xs"
                />
                {fileSearch && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setFileSearch('')}
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
              {t('review.loading', 'Loading changes...')}
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
                      <span className="flex-1 truncate font-mono text-[11px]">{f.path}</span>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            onClick={(e) => e.stopPropagation()}
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
                value={commitTitle}
                onChange={(e) => setCommitTitle(e.target.value)}
                disabled={!!actionInProgress}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <div className="rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring">
                <textarea
                  className="w-full px-2 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none resize-none bg-transparent"
                  rows={7}
                  placeholder={t('review.commitBody')}
                  value={commitBody}
                  onChange={(e) => setCommitBody(e.target.value)}
                  disabled={!!actionInProgress}
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
              <div className={cn('grid gap-1', isWorktree ? 'grid-cols-4' : 'grid-cols-3')}>
                {([
                  { value: 'commit' as const, icon: GitCommit, label: t('review.commit', 'Commit') },
                  { value: 'commit-push' as const, icon: Upload, label: t('review.commitAndPush', 'Commit & Push') },
                  { value: 'commit-pr' as const, icon: GitPullRequest, label: t('review.commitAndCreatePR', 'Commit & Create PR') },
                  ...(isWorktree ? [{ value: 'commit-merge' as const, icon: GitMerge, label: t('review.commitAndMerge', 'Commit & Merge') }] : []),
                ]).map(({ value, icon: ActionIcon, label }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setSelectedAction(value)}
                    disabled={!!actionInProgress}
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
                ))}
              </div>
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
          )}

          {/* Standalone push button — shown when no dirty files but there are unpushed commits */}
          {showPushOnly && (
            <div className="border-t border-sidebar-border p-3 flex-shrink-0 space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Upload className="h-3.5 w-3.5" />
                <span>{t('review.readyToPush', { count: gitStatus!.unpushedCommitCount, defaultValue: `${gitStatus!.unpushedCommitCount} commit(s) ready to push` })}</span>
              </div>
              <Button
                className="w-full"
                size="sm"
                onClick={handlePushOnly}
                disabled={pushInProgress}
              >
                {pushInProgress ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Upload className="h-3.5 w-3.5 mr-1.5" />}
                {t('review.pushToOrigin', 'Push to origin')}
              </Button>
            </div>
          )}

          {/* Standalone merge button — shown when no dirty files but worktree has unmerged commits */}
          {showMergeOnly && (
            <div className="border-t border-sidebar-border p-3 flex-shrink-0 space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <GitMerge className="h-3.5 w-3.5" />
                <span>{t('review.readyToMerge', { target: baseBranch || 'base', defaultValue: `Ready to merge into ${baseBranch || 'base'}` })}</span>
              </div>
              <Button
                className="w-full"
                size="sm"
                onClick={handleMergeOnly}
                disabled={mergeInProgress}
              >
                {mergeInProgress ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <GitMerge className="h-3.5 w-3.5 mr-1.5" />}
                {t('review.mergeIntoBranch', { target: baseBranch || 'base', defaultValue: `Merge into ${baseBranch || 'base'}` })}
              </Button>
            </div>
          )}
        </div>
      </div>

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
                      Loading diff...
                    </div>
                  ) : expandedDiffContent ? (
                    <div className="[&_.diff-container]:font-mono [&_table]:w-full [&_td]:overflow-hidden [&_td]:text-ellipsis">
                      <Suspense fallback={<div className="p-4 text-sm text-muted-foreground">Loading diff...</div>}>
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
