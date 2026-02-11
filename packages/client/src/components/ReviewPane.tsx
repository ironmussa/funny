import { useState, useEffect, useMemo, memo, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/app-store';
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  X,
  RefreshCw,
  Plus,
  Minus,
  Undo2,
  GitCommit,
  Upload,
  GitPullRequest,
  GitMerge,
  GitBranch,
  FileCode,
  FilePlus,
  FileX,
  Sparkles,
} from 'lucide-react';
import type { FileDiff } from '@a-parallel/shared';
import { useGitStatusStore } from '@/stores/git-status-store';

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

const MemoizedDiffView = memo(function MemoizedDiffView({ diff }: { diff: string }) {
  const oldValue = useMemo(() => parseDiffOld(diff), [diff]);
  const newValue = useMemo(() => parseDiffNew(diff), [diff]);

  return (
    <ReactDiffViewer
      oldValue={oldValue}
      newValue={newValue}
      splitView={false}
      useDarkTheme={true}
      hideLineNumbers={false}
      showDiffOnly={true}
      styles={DIFF_VIEWER_STYLES}
    />
  );
});

export function ReviewPane() {
  const { t } = useTranslation();
  const activeThread = useAppStore(s => s.activeThread);
  const setReviewPaneOpen = useAppStore(s => s.setReviewPaneOpen);
  const [diffs, setDiffs] = useState<FileDiff[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [merging, setMerging] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [revertConfirm, setRevertConfirm] = useState<{ paths: string[] } | null>(null);
  const [mergeConfirm, setMergeConfirm] = useState<{ push?: boolean; cleanup?: boolean } | null>(null);
  const [prDialog, setPrDialog] = useState(false);
  const [prTitle, setPrTitle] = useState('');
  const [generatingMsg, setGeneratingMsg] = useState(false);

  const threadId = activeThread?.id;
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null);

  // Fetch default branch as fallback for threads without baseBranch
  useEffect(() => {
    if (activeThread?.mode === 'worktree' && activeThread?.branch && !activeThread?.baseBranch && activeThread?.projectId) {
      api.listBranches(activeThread.projectId)
        .then(result => { if (result.isOk()) setDefaultBranch(result.value.defaultBranch); });
    }
  }, [activeThread?.projectId, activeThread?.mode, activeThread?.branch, activeThread?.baseBranch]);

  const mergeTarget = activeThread?.baseBranch || defaultBranch;
  const hasUncommittedChanges = diffs.length > 0;
  const hasStagedFiles = diffs.some(d => d.staged);
  const hasStagedChanges = hasStagedFiles; // Only staged files block push/PR/merge

  const gitStatus = useGitStatusStore(s => threadId ? s.statusByThread[threadId] : undefined);
  const hasCommitsToPush = (gitStatus?.unpushedCommitCount ?? 0) > 0;
  const isWorktree = activeThread?.mode === 'worktree' && !!activeThread?.branch && !!mergeTarget;

  const refresh = async () => {
    if (!threadId) return;
    setLoading(true);
    const result = await api.getDiff(threadId);
    if (result.isOk()) {
      const data = result.value;
      setDiffs(data);
      if (data.length > 0 && !selectedFile) {
        setSelectedFile(data[0].path);
      }
    } else {
      console.error('Failed to load diff:', result.error);
    }
    setLoading(false);
  };

  useEffect(() => {
    refresh();
    // Fetch git status on mount
    if (threadId) {
      useGitStatusStore.getState().fetchForThread(threadId);
    }
  }, [threadId]);

  // Auto-refresh diffs when agent modifies files (debounced 2s)
  useAutoRefreshDiff(threadId, refresh, 2000);

  const selectedDiff = diffs.find((d) => d.path === selectedFile);

  const handleStage = async (paths: string[]) => {
    if (!threadId) return;
    const result = await api.stageFiles(threadId, paths);
    if (result.isErr()) {
      toast.error(t('review.stageFailed', { message: result.error.message }));
      return;
    }
    await refresh();
  };

  const handleUnstage = async (paths: string[]) => {
    if (!threadId) return;
    const result = await api.unstageFiles(threadId, paths);
    if (result.isErr()) {
      toast.error(t('review.unstageFailed', { message: result.error.message }));
      return;
    }
    await refresh();
  };

  const handleRevert = async (paths: string[]) => {
    if (!threadId) return;
    const result = await api.revertFiles(threadId, paths);
    if (result.isErr()) {
      toast.error(t('review.revertFailed', { message: result.error.message }));
      return;
    }
    await refresh();
  };

  const handleCommit = async () => {
    if (!threadId || !commitMsg.trim()) return;
    const result = await api.commit(threadId, commitMsg);
    if (result.isErr()) {
      toast.error(t('review.commitFailed', { message: result.error.message }));
      return;
    }
    setCommitMsg('');
    toast.success(t('review.commitSuccess'));
    await refresh();
    useGitStatusStore.getState().fetchForThread(threadId);
  };

  const handleGenerateCommitMsg = async () => {
    if (!threadId || generatingMsg) return;
    setGeneratingMsg(true);
    const result = await api.generateCommitMessage(threadId);
    if (result.isOk()) {
      setCommitMsg(result.value.message);
    } else {
      toast.error(t('review.generateFailed', { message: result.error.message }));
    }
    setGeneratingMsg(false);
  };

  const handlePush = async () => {
    if (!threadId) return;
    setPushing(true);
    const result = await api.push(threadId);
    if (result.isOk()) {
      toast.success(t('review.pushedSuccess'));
      useGitStatusStore.getState().fetchForThread(threadId);
    } else {
      toast.error(t('review.pushFailed', { message: result.error.message }));
    }
    setPushing(false);
  };

  const handleMerge = async (opts?: { push?: boolean; cleanup?: boolean }) => {
    if (!threadId || !activeThread?.branch || !mergeTarget) return;

    setMerging(true);
    const result = await api.merge(threadId, {
      targetBranch: mergeTarget,
      push: opts?.push ?? false,
      cleanup: opts?.cleanup ?? false,
    });
    if (result.isOk()) {
      toast.success(t('review.mergeSuccess', { branch: activeThread.branch, target: mergeTarget }));
      await refresh();
      useGitStatusStore.getState().fetchForThread(threadId);
    } else {
      toast.error(t('review.mergeFailed', { message: result.error.message }));
    }
    setMerging(false);
  };

  return (
    <div className="flex flex-col h-full animate-slide-in-right">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">{t('review.title')}</h3>
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
            <TooltipContent>{t('review.refresh')}</TooltipContent>
          </Tooltip>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setReviewPaneOpen(false)}
          className="text-muted-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* File list */}
      <ScrollArea className="border-b border-border max-h-48">
        {diffs.length === 0 ? (
          <p className="text-xs text-muted-foreground p-3">{t('review.noChanges')}</p>
        ) : (
          diffs.map((f) => {
            const Icon = fileStatusIcons[f.status] || FileCode;
            return (
              <div
                key={f.path}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer transition-colors',
                  selectedFile === f.path
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-accent/50 text-muted-foreground'
                )}
                onClick={() => setSelectedFile(f.path)}
              >
                <Icon className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="flex-1 truncate font-mono">{f.path}</span>
                <span className={cn('text-[10px]', f.staged ? 'text-green-400' : 'text-yellow-400')}>
                  {f.staged ? t('review.staged') : t('review.unstaged')}
                </span>
                <div className="flex gap-0.5">
                  {f.staged ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={(e) => { e.stopPropagation(); handleUnstage([f.path]); }}
                        >
                          <Minus className="h-3 w-3" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('review.unstage')}</TooltipContent>
                    </Tooltip>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={(e) => { e.stopPropagation(); handleStage([f.path]); }}
                        >
                          <Plus className="h-3 w-3" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('review.stage')}</TooltipContent>
                    </Tooltip>
                  )}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={(e) => { e.stopPropagation(); setRevertConfirm({ paths: [f.path] }); }}
                        className="text-destructive"
                      >
                        <Undo2 className="h-3 w-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('review.revert')}</TooltipContent>
                  </Tooltip>
                </div>
              </div>
            );
          })
        )}
      </ScrollArea>

      {/* Diff viewer */}
      <ScrollArea className="flex-1 w-full">
        {selectedDiff ? (
          selectedDiff.diff ? (
            <div className="text-xs [&_.diff-container]:font-mono [&_.diff-container]:text-[11px] [&_table]:w-max [&_td:last-child]:w-auto [&_td:last-child]:min-w-0">
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

      {/* Git actions */}
      <div className="p-3 border-t border-border space-y-2">
        {/* Branch context */}
        {activeThread?.branch && (
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground px-0.5">
            <GitBranch className="h-3 w-3 flex-shrink-0" />
            <span className="truncate font-mono">{activeThread.branch.replace(/^[^/]+\//, '')}</span>
            {mergeTarget && (
              <span className="text-muted-foreground/50 flex-shrink-0">→ {mergeTarget}</span>
            )}
          </div>
        )}

        {/* Commit */}
        <div className="space-y-1.5">
          <textarea
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs placeholder:text-muted-foreground transition-[border-color,box-shadow] duration-150 focus:outline-none focus:ring-1 focus:ring-ring resize-none"
            rows={3}
            placeholder={t('review.commitMessage')}
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleCommit();
              }
            }}
            disabled={!hasStagedFiles}
          />
          <div className="flex gap-1 justify-end">
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    size="icon-sm"
                    onClick={handleCommit}
                    disabled={!commitMsg.trim() || !hasStagedFiles}
                  >
                    <GitCommit className="h-3.5 w-3.5" />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {!hasStagedFiles ? t('review.stageFirst') : t('review.commitTooltip')}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={handleGenerateCommitMsg}
                    disabled={!hasStagedFiles || generatingMsg}
                  >
                    <Sparkles className={cn('h-3.5 w-3.5', generatingMsg && 'animate-pulse')} />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {generatingMsg ? t('review.generatingCommitMsg') : t('review.generateCommitMsg')}
              </TooltipContent>
            </Tooltip>

            <div className="w-px bg-border mx-0.5" />

            {/* Push */}
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={handlePush}
                    disabled={pushing || hasStagedChanges || !hasCommitsToPush}
                  >
                    <Upload className={cn('h-3.5 w-3.5', pushing && 'animate-spin')} />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {hasStagedChanges
                  ? t('review.commitFirst')
                  : !hasCommitsToPush
                    ? t('review.nothingToPush')
                    : t('review.pushTooltip', { branch: activeThread?.branch?.replace(/^[^/]+\//, '') ?? '' })}
              </TooltipContent>
            </Tooltip>

            {/* Create PR */}
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => { setPrTitle(''); setPrDialog(true); }}
                    disabled={hasStagedChanges || !hasCommitsToPush}
                  >
                    <GitPullRequest className="h-3.5 w-3.5" />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {hasStagedChanges
                  ? t('review.commitFirst')
                  : !hasCommitsToPush
                    ? t('review.nothingToPush')
                    : t('review.createPRTooltip', {
                      branch: activeThread?.branch?.replace(/^[^/]+\//, '') ?? '',
                      target: mergeTarget ?? 'default',
                    })}
              </TooltipContent>
            </Tooltip>

            {/* Merge (worktree only) */}
            {isWorktree && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setMergeConfirm({})}
                      disabled={merging || hasStagedChanges || !hasCommitsToPush}
                    >
                      <GitMerge className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {hasStagedChanges
                    ? t('review.commitFirst')
                    : !hasCommitsToPush
                      ? t('review.nothingToPush')
                      : t('review.mergeTooltip', {
                        branch: activeThread!.branch!.replace(/^[^/]+\//, ''),
                        target: mergeTarget!,
                      })}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </div>

      {/* Revert confirmation dialog */}
      <Dialog open={!!revertConfirm} onOpenChange={(open) => { if (!open) setRevertConfirm(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('review.revert')}</DialogTitle>
            <DialogDescription asChild>
              <div>
                <span className="font-mono text-xs">{revertConfirm?.paths.join(', ')}</span>
                <p className="mt-1">{t('review.revertWarning')}</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRevertConfirm(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => {
              if (revertConfirm) handleRevert(revertConfirm.paths);
              setRevertConfirm(null);
            }}>
              {t('review.revert')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Merge confirmation dialog */}
      <Dialog open={!!mergeConfirm} onOpenChange={(open) => { if (!open) setMergeConfirm(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('review.merge')}</DialogTitle>
            <DialogDescription>
              {t('review.mergeConfirm', {
                branch: activeThread?.branch ?? '',
                target: mergeTarget ?? '',
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setMergeConfirm(null)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={() => {
              const opts = mergeConfirm;
              setMergeConfirm(null);
              handleMerge(opts ?? undefined);
            }}>
              {mergeConfirm?.cleanup ? t('review.mergeAndCleanup') : t('review.merge')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create PR dialog */}
      <Dialog open={prDialog} onOpenChange={(open) => { if (!open) setPrDialog(false); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('review.createPR')}</DialogTitle>
          </DialogHeader>
          <input
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder={t('review.prTitle')}
            value={prTitle}
            onChange={(e) => setPrTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && prTitle.trim() && threadId) {
                setPrDialog(false);
                const body = activeThread?.branch
                  ? `Branch: \`${activeThread.branch}\`\nBase: \`${activeThread.baseBranch || 'default'}\``
                  : '';
                api.createPR(threadId, prTitle, body).then((result) => result.match(() => toast.success(t('review.prCreated')), (error) => toast.error(error.message)));
              }
            }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPrDialog(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" disabled={!prTitle.trim()} onClick={() => {
              if (!threadId || !prTitle.trim()) return;
              setPrDialog(false);
              const body = activeThread?.branch
                ? `Branch: \`${activeThread.branch}\`\nBase: \`${activeThread.baseBranch || 'default'}\``
                : '';
              api.createPR(threadId, prTitle, body).then((result) => result.match(() => toast.success(t('review.prCreated')), (error) => toast.error(error.message)));
            }}>
              {t('review.createPR')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
