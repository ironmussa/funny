import { useState, useEffect, useMemo, memo, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { ReactDiffViewer, DIFF_VIEWER_STYLES } from './tool-cards/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { useAutoRefreshDiff } from '@/hooks/use-auto-refresh-diff';
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
  Upload,
  GitPullRequest,
  Sparkles,
  Loader2,
  Check,
  Undo2,
} from 'lucide-react';
import type { FileDiff } from '@a-parallel/shared';

const fileStatusIcons: Record<string, typeof FileCode> = {
  added: FilePlus,
  modified: FileCode,
  deleted: FileX,
  renamed: FileCode,
};

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

  const [diffs, setDiffs] = useState<FileDiff[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [fileSearch, setFileSearch] = useState('');
  const [checkedFiles, setCheckedFiles] = useState<Set<string>>(new Set());
  const [commitTitle, setCommitTitle] = useState('');
  const [commitBody, setCommitBody] = useState('');
  const [generatingMsg, setGeneratingMsg] = useState(false);
  const [selectedAction, setSelectedAction] = useState<'commit' | 'commit-push' | 'commit-pr'>('commit');
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  const refresh = async () => {
    if (!effectiveThreadId) return;
    setLoading(true);
    const result = await api.getDiff(effectiveThreadId);
    if (result.isOk()) {
      const data = result.value;
      setDiffs(data);
      // Check all files by default, preserving existing selections
      setCheckedFiles(prev => {
        const next = new Set(prev);
        for (const f of data) {
          if (!prev.has(f.path) && prev.size === 0) {
            // First load: check all
            next.add(f.path);
          } else if (!prev.has(f.path) && data.length > prev.size) {
            // New file appeared: check it
            next.add(f.path);
          }
        }
        // Remove files that no longer exist
        for (const p of prev) {
          if (!data.find(d => d.path === p)) next.delete(p);
        }
        return next.size === 0 ? new Set(data.map(d => d.path)) : next;
      });
      if (data.length > 0 && !selectedFile) {
        setSelectedFile(data[0].path);
      }
    } else {
      console.error('Failed to load diff:', result.error);
    }
    setLoading(false);
  };

  // Reset state and refresh only when the git working directory changes.
  // Switching between threads that share the same branch/worktree won't re-fetch.
  useEffect(() => {
    setDiffs([]);
    setSelectedFile(null);
    setCheckedFiles(new Set());
    setCommitTitle('');
    setCommitBody('');
    setFileSearch('');
    refresh();
  }, [gitContextKey]);

  // Auto-refresh diffs when agent modifies files (debounced 2s)
  useAutoRefreshDiff(effectiveThreadId, refresh, 2000);

  const filteredDiffs = useMemo(() => {
    if (!fileSearch) return diffs;
    const query = fileSearch.toLowerCase();
    return diffs.filter(d => d.path.toLowerCase().includes(query));
  }, [diffs, fileSearch]);

  const selectedDiff = diffs.find((d) => d.path === selectedFile);

  const checkedCount = checkedFiles.size;
  const totalCount = diffs.length;

  const toggleFile = (path: string) => {
    setCheckedFiles(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleAll = () => {
    if (checkedFiles.size === diffs.length) {
      setCheckedFiles(new Set());
    } else {
      setCheckedFiles(new Set(diffs.map(d => d.path)));
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

    const filesToCommit = Array.from(checkedFiles);

    // Unstage everything first to start clean
    const currentlyStaged = diffs.filter(f => f.staged).map(f => f.path);
    if (currentlyStaged.length > 0) {
      const unstageResult = await api.unstageFiles(effectiveThreadId, currentlyStaged);
      if (unstageResult.isErr()) {
        toast.error(t('review.unstageFailed', { message: unstageResult.error.message }));
        return false;
      }
    }

    // Stage only checked files
    const stageResult = await api.stageFiles(effectiveThreadId, filesToCommit);
    if (stageResult.isErr()) {
      toast.error(t('review.stageFailed', { message: stageResult.error.message }));
      return false;
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
    }

    setCommitTitle('');
    setCommitBody('');
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
            {selectedDiff ? (
              selectedDiff.diff ? (
                <div className="relative text-xs [&_.diff-container]:font-mono [&_.diff-container]:text-sm [&_table]:w-max [&_td:last-child]:w-auto [&_td:last-child]:min-w-0">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="secondary"
                        size="icon-xs"
                        onClick={() => setExpandedFile(selectedDiff.path)}
                        className="sticky top-2 right-2 z-10 opacity-70 hover:opacity-100 shadow-md float-right mr-2 mt-2"
                      >
                        <Maximize2 className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="left">{t('review.expand', 'Expand')}</TooltipContent>
                  </Tooltip>
                  <Suspense fallback={<div className="p-2 text-xs text-muted-foreground">Loading diff...</div>}>
                    <MemoizedDiffView diff={selectedDiff.diff} />
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
          {/* File search */}
          {diffs.length > 0 && (
            <div className="px-2 py-2 border-b border-sidebar-border">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  type="text"
                  placeholder={t('review.searchFiles', 'Filter files...')}
                  value={fileSearch}
                  onChange={(e) => setFileSearch(e.target.value)}
                  className="h-7 pl-7 pr-7 text-xs"
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
          {diffs.length > 0 && (
            <div className="flex items-center gap-1.5 px-4 py-1.5 border-b border-sidebar-border">
              <button
                onClick={toggleAll}
                className={cn(
                  'flex items-center justify-center h-3.5 w-3.5 rounded border transition-colors flex-shrink-0',
                  checkedFiles.size === diffs.length
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

          {/* File list */}
          <ScrollArea className="flex-1">
            {loading ? (
              <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t('review.loading', 'Loading changes...')}
              </div>
            ) : diffs.length === 0 ? (
              <p className="text-xs text-muted-foreground p-3">{t('review.noChanges')}</p>
            ) : filteredDiffs.length === 0 ? (
              <p className="text-xs text-muted-foreground p-3">{t('review.noMatchingFiles', 'No matching files')}</p>
            ) : (
              filteredDiffs.map((f) => {
                const Icon = fileStatusIcons[f.status] || FileCode;
                const isChecked = checkedFiles.has(f.path);
                return (
                  <div
                    key={f.path}
                    className={cn(
                      'group flex items-center gap-1.5 px-4 py-1 text-xs cursor-pointer transition-colors',
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
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleRevertFile(f.path); }}
                          className="hidden group-hover:flex items-center justify-center h-4 w-4 rounded text-muted-foreground hover:text-destructive transition-colors flex-shrink-0"
                        >
                          <Undo2 className="h-3 w-3" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="left">{t('review.revert')}</TooltipContent>
                    </Tooltip>
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
              })
            )}
          </ScrollArea>

          {/* Commit controls */}
          {diffs.length > 0 && (
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
                        disabled={diffs.length === 0 || generatingMsg || !!actionInProgress}
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
              <div className="grid grid-cols-3 gap-1">
                {([
                  { value: 'commit' as const, icon: GitCommit, label: t('review.commit', 'Commit') },
                  { value: 'commit-push' as const, icon: Upload, label: t('review.commitAndPush', 'Commit & Push') },
                  { value: 'commit-pr' as const, icon: GitPullRequest, label: t('review.commitAndCreatePR', 'Commit & Create PR') },
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
        </div>
      </div>

      {/* Expanded diff modal */}
      <Dialog open={!!expandedFile} onOpenChange={(open) => { if (!open) setExpandedFile(null); }}>
        <DialogContent className="max-w-[90vw] w-[90vw] h-[85vh] flex flex-col p-0 gap-0">
          {(() => {
            const expandedDiff = diffs.find(d => d.path === expandedFile);
            if (!expandedDiff) return null;
            const Icon = fileStatusIcons[expandedDiff.status] || FileCode;
            return (
              <>
                <DialogHeader className="px-4 py-3 pr-10 border-b border-border flex-shrink-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <Icon className="h-4 w-4 flex-shrink-0" />
                    <DialogTitle className="font-mono text-sm truncate">{expandedDiff.path}</DialogTitle>
                  </div>
                  <DialogDescription className="sr-only">
                    {t('review.diffFor', { file: expandedDiff.path, defaultValue: `Diff for ${expandedDiff.path}` })}
                  </DialogDescription>
                </DialogHeader>
                <ScrollArea className="flex-1 min-h-0">
                  {expandedDiff.diff ? (
                    <div className="[&_.diff-container]:font-mono [&_table]:w-full [&_td]:overflow-hidden [&_td]:text-ellipsis">
                      <Suspense fallback={<div className="p-4 text-sm text-muted-foreground">Loading diff...</div>}>
                        <MemoizedDiffView diff={expandedDiff.diff} splitView={true} />
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
