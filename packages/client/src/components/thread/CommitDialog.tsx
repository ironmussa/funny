import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/app-store';
import { useGitStatusStore } from '@/stores/git-status-store';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  GitBranch,
  GitCommit,
  Sparkles,
  FileCode,
  FilePlus,
  FileX,
  Loader2,
  Upload,
  GitPullRequest,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
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
import type { FileDiff } from '@a-parallel/shared';

const fileStatusIcons: Record<string, typeof FileCode> = {
  added: FilePlus,
  modified: FileCode,
  deleted: FileX,
  renamed: FileCode,
};

interface FileToggleProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}

function FileToggle({ checked, onCheckedChange, disabled }: FileToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-input'
      )}
    >
      <span
        className={cn(
          'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0'
        )}
      />
    </button>
  );
}

interface CommitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommitDialog({ open, onOpenChange }: CommitDialogProps) {
  const { t } = useTranslation();
  const activeThread = useAppStore(s => s.activeThread);
  const threadId = activeThread?.id;

  const [allFiles, setAllFiles] = useState<FileDiff[]>([]);
  const [selectedFiles, setSelectedFiles] = useState(() => new Set<string>());
  const [includeUnstaged, setIncludeUnstaged] = useState(true);
  const [commitTitle, setCommitTitle] = useState('');
  const [commitBody, setCommitBody] = useState('');
  const [generatingMsg, setGeneratingMsg] = useState(false);
  const [actionInProgress, setActionInProgress] = useState<'commit' | 'commit-push' | 'commit-pr' | null>(null);
  const [selectedAction, setSelectedAction] = useState<'commit' | 'commit-push' | 'commit-pr'>('commit');

  const gitStatus = useGitStatusStore(s => threadId ? s.statusByThread[threadId] : undefined);
  const stagedFiles = allFiles.filter(f => f.staged);
  const unstagedFiles = allFiles.filter(f => !f.staged);
  const hasMessage = commitTitle.trim().length > 0;
  const canCommit = includeUnstaged
    ? allFiles.length > 0 && hasMessage && !actionInProgress
    : selectedFiles.size > 0 && hasMessage && !actionInProgress;

  const refreshDiffs = async () => {
    if (!threadId) return;
    const result = await api.getDiff(threadId);
    if (result.isOk()) {
      setAllFiles(result.value);
      setSelectedFiles(new Set(result.value.map(f => f.path)));
    }
  };

  useEffect(() => {
    if (open) {
      refreshDiffs();
      if (threadId) useGitStatusStore.getState().fetchForThread(threadId);
      setCommitTitle('');
      setCommitBody('');
      setActionInProgress(null);
    }
  }, [open, threadId]);

  const handleGenerateCommitMsg = async () => {
    if (!threadId || generatingMsg) return;
    setGeneratingMsg(true);
    const result = await api.generateCommitMessage(threadId, includeUnstaged);
    if (result.isOk()) {
      setCommitTitle(result.value.title);
      setCommitBody(result.value.body);
    } else {
      toast.error(t('review.generateFailed', { message: result.error.message }));
    }
    setGeneratingMsg(false);
  };

  const performCommit = async (): Promise<boolean> => {
    if (!threadId || !hasMessage) return false;

    // Build commit message from title and body
    const commitMsg = commitBody.trim()
      ? `${commitTitle.trim()}\n\n${commitBody.trim()}`
      : commitTitle.trim();

    if (includeUnstaged) {
      // Stage all files and commit everything
      const unstaged = allFiles.filter(f => !f.staged).map(f => f.path);
      if (unstaged.length > 0) {
        const stageResult = await api.stageFiles(threadId, unstaged);
        if (stageResult.isErr()) {
          toast.error(t('review.stageFailed', { message: stageResult.error.message }));
          return false;
        }
      }

      const result = await api.commit(threadId, commitMsg);
      if (result.isErr()) {
        toast.error(t('review.commitFailed', { message: result.error.message }));
        if (unstaged.length > 0) await api.unstageFiles(threadId, unstaged);
        return false;
      }
      return true;
    }

    // Manual mode: only commit selected staged files
    const selected = Array.from(selectedFiles);
    const currentlyStaged = stagedFiles.map(f => f.path);

    const toUnstage = currentlyStaged.filter(p => !selectedFiles.has(p));
    if (toUnstage.length > 0) {
      const unstageResult = await api.unstageFiles(threadId, toUnstage);
      if (unstageResult.isErr()) {
        toast.error(t('review.unstageFailed', { message: unstageResult.error.message }));
        return false;
      }
    }

    const result = await api.commit(threadId, commitMsg);
    if (result.isErr()) {
      toast.error(t('review.commitFailed', { message: result.error.message }));
      if (toUnstage.length > 0) await api.stageFiles(threadId, toUnstage);
      return false;
    }

    if (toUnstage.length > 0) {
      await api.stageFiles(threadId, toUnstage);
    }

    return true;
  };

  const handleCommit = async () => {
    if (!canCommit) return;
    setActionInProgress('commit');
    const success = await performCommit();
    if (success) {
      toast.success(t('review.commitSuccess'));
      useGitStatusStore.getState().fetchForThread(threadId!);
      onOpenChange(false);
    }
    setActionInProgress(null);
  };

  const handleCommitAndPush = async () => {
    if (!canCommit || !threadId) return;
    setActionInProgress('commit-push');

    const commitSuccess = await performCommit();
    if (!commitSuccess) {
      setActionInProgress(null);
      return;
    }

    const pushResult = await api.push(threadId);
    if (pushResult.isErr()) {
      toast.error(t('review.pushFailed', { message: pushResult.error.message }));
      setActionInProgress(null);
      useGitStatusStore.getState().fetchForThread(threadId);
      onOpenChange(false);
      return;
    }

    toast.success(t('review.pushedSuccess'));
    useGitStatusStore.getState().fetchForThread(threadId);
    onOpenChange(false);
    setActionInProgress(null);
  };

  const handleCommitAndCreatePR = async () => {
    if (!canCommit || !threadId) return;
    setActionInProgress('commit-pr');

    const commitSuccess = await performCommit();
    if (!commitSuccess) {
      setActionInProgress(null);
      return;
    }

    const pushResult = await api.push(threadId);
    if (pushResult.isErr()) {
      toast.error(t('review.pushFailed', { message: pushResult.error.message }));
      setActionInProgress(null);
      useGitStatusStore.getState().fetchForThread(threadId);
      onOpenChange(false);
      return;
    }

    const prTitle = commitTitle.trim();
    const prBody = commitBody.trim();
    const prResult = await api.createPR(threadId, prTitle, prBody);
    if (prResult.isErr()) {
      toast.error(t('review.prFailed', { message: prResult.error.message }));
      setActionInProgress(null);
      useGitStatusStore.getState().fetchForThread(threadId);
      onOpenChange(false);
      return;
    }

    if (prResult.value.url) {
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

    useGitStatusStore.getState().fetchForThread(threadId);
    onOpenChange(false);
    setActionInProgress(null);
  };

  const toggleFile = (path: string) => {
    const newSelection = new Set(selectedFiles);
    if (newSelection.has(path)) {
      newSelection.delete(path);
    } else {
      newSelection.add(path);
    }
    setSelectedFiles(newSelection);
  };

  const toggleSelectAll = () => {
    if (selectedFiles.size === stagedFiles.length) {
      setSelectedFiles(new Set());
    } else {
      setSelectedFiles(new Set(stagedFiles.map(f => f.path)));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('review.commitDialogTitle', 'Commit Changes')}</DialogTitle>
          <DialogDescription className="flex items-center gap-3 text-xs">
            {activeThread?.branch && (
              <span className="flex items-center gap-1.5">
                <GitBranch className="h-3 w-3" />
                <span className="font-mono">{activeThread.branch}</span>
              </span>
            )}
            {allFiles.length > 0 && (
              <span className="flex items-center gap-1.5">
                <span className="font-medium text-status-success">{stagedFiles.length} staged</span>
                <span className="text-muted-foreground">|</span>
                <span className="font-medium text-status-pending">{unstagedFiles.length} unstaged</span>
              </span>
            )}
            {gitStatus && (gitStatus.linesAdded > 0 || gitStatus.linesDeleted > 0) && (
              <span className="flex items-center gap-1.5 font-mono">
                <span className="text-status-success">+{gitStatus.linesAdded}</span>
                <span className="text-status-error">-{gitStatus.linesDeleted}</span>
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Include unstaged toggle */}
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-muted-foreground">
              {t('review.includeUnstaged', 'Include unstaged')}
            </label>
            <FileToggle
              checked={includeUnstaged}
              onCheckedChange={(v) => {
                setIncludeUnstaged(v);
                if (!v) {
                  setSelectedFiles(new Set(stagedFiles.map(f => f.path)));
                }
              }}
              disabled={!!actionInProgress}
            />
          </div>

          {/* Staged files list — only when manual mode */}
          {!includeUnstaged && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('review.filesToCommit', 'Staged files')} ({selectedFiles.size}/{stagedFiles.length})
                </span>
                {stagedFiles.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={toggleSelectAll}
                    className="h-6 text-xs"
                  >
                    {selectedFiles.size === stagedFiles.length ? t('review.deselectAll', 'Deselect All') : t('review.selectAll', 'Select All')}
                  </Button>
                )}
              </div>

              {stagedFiles.length === 0 ? (
                <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-4 text-center">
                  <p className="text-xs text-muted-foreground">
                    {t('review.stageFirst', 'No staged files. Use the Review pane to stage changes.')}
                  </p>
                </div>
              ) : (
                <ScrollArea className="max-h-48 rounded-md border border-border/60">
                  <div className="p-1">
                    {stagedFiles.map((file) => {
                      const Icon = fileStatusIcons[file.status] || FileCode;
                      const isSelected = selectedFiles.has(file.path);
                      return (
                        <div
                          key={file.path}
                          className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent/50 transition-colors"
                        >
                          <FileToggle
                            checked={isSelected}
                            onCheckedChange={() => toggleFile(file.path)}
                            disabled={!!actionInProgress}
                          />
                          <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                          <span className="flex-1 truncate text-xs font-mono">{file.path}</span>
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>
              )}
            </div>
          )}

          {/* Commit Title and Body Section */}
          <div className="space-y-3">
            <input
              type="text"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground transition-[border-color,box-shadow] duration-150 focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder={t('review.commitTitle')}
              value={commitTitle}
              onChange={(e) => setCommitTitle(e.target.value)}
              disabled={allFiles.length === 0 || !!actionInProgress}
            />
            <div className="relative">
              <textarea
                className="w-full rounded-md border border-input bg-background px-3 py-2 pb-9 text-sm placeholder:text-muted-foreground transition-[border-color,box-shadow] duration-150 focus:outline-none focus:ring-1 focus:ring-ring resize-none"
                rows={5}
                placeholder={t('review.commitBody')}
                value={commitBody}
                onChange={(e) => setCommitBody(e.target.value)}
                disabled={allFiles.length === 0 || !!actionInProgress}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="absolute bottom-2 left-2 bg-background hover:bg-accent"
                    onClick={handleGenerateCommitMsg}
                    disabled={allFiles.length === 0 || generatingMsg || !!actionInProgress}
                  >
                    <Sparkles className={cn('h-3.5 w-3.5', generatingMsg && 'animate-pulse')} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {generatingMsg ? t('review.generatingCommitMsg') : t('review.generateCommitMsg')}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 pt-2">
          <div className="grid grid-cols-3 gap-2">
            {([
              { value: 'commit' as const, icon: GitCommit, label: t('review.commit', 'Commit') },
              { value: 'commit-push' as const, icon: Upload, label: t('review.commitAndPush', 'Commit & Push') },
              { value: 'commit-pr' as const, icon: GitPullRequest, label: t('review.commitAndCreatePR', 'Commit & Create PR') },
            ]).map(({ value, icon: Icon, label }) => {
              const isSelected = selectedAction === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setSelectedAction(value)}
                  disabled={!!actionInProgress}
                  className={cn(
                    'relative flex flex-col items-center gap-2 rounded-lg border p-3 text-center transition-all',
                    'hover:bg-accent/50 disabled:opacity-50 disabled:cursor-not-allowed',
                    isSelected
                      ? 'border-primary bg-primary/5 text-foreground shadow-sm'
                      : 'border-border text-muted-foreground'
                  )}
                >
                  <Icon className={cn('h-5 w-5', isSelected && 'text-primary')} />
                  <span className="text-xs font-medium leading-tight">{label}</span>
                </button>
              );
            })}
          </div>
          <Button
            onClick={() => {
              if (selectedAction === 'commit') handleCommit();
              else if (selectedAction === 'commit-push') handleCommitAndPush();
              else handleCommitAndCreatePR();
            }}
            disabled={!canCommit}
          >
            {actionInProgress ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            {t('review.continue', 'Continue')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
