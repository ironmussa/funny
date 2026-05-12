import type { FileDiffSummary, FileStatus } from '@funny/shared';
import { FileCode, GitBranch, GitCommit, History, Loader2, RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { AuthorBadge } from '@/components/AuthorBadge';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FileTree } from '@/components/FileTree';
import { ExpandedDiffView } from '@/components/tool-cards/ExpandedDiffDialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { ResizeHandle, useResizeHandle } from '@/components/ui/resize-handle';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SearchBar } from '@/components/ui/search-bar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { parseDiffNew, parseDiffOld } from '@/lib/diff-parse';
import { shortRelativeDate } from '@/lib/thread-utils';
import { toastError } from '@/lib/toast-error';
import { useGitStatusStore } from '@/stores/git-status-store';

interface LogEntry {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  relativeDate: string;
  message: string;
}

interface CommitFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

const SIDEBAR_WIDTH_STORAGE_KEY = 'commit-detail-dialog:sidebar-width';
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 600;
const SIDEBAR_DEFAULT_WIDTH = 280;

interface Props {
  selectedCommit: LogEntry | undefined;
  selectedHash: string | null;
  effectiveThreadId: string | undefined;
  projectModeId: string | null;
  githubAvatarBySha: Map<string, string>;
  onClose: () => void;
  onAfterAction: () => void;
}

/**
 * Modal that opens when the user clicks a commit row: shows commit metadata,
 * a filtered file tree on the left, the diff for the selected file on the
 * right, plus checkout/revert/reset actions (each gated by a ConfirmDialog).
 *
 * Owns its own loaded-files / commit-body / file-search / diff-content
 * state and the 3 destructive-action handlers, so CommitHistoryTab.tsx
 * doesn't have to import the Dialog cluster, FileTree, ExpandedDiffView,
 * diff-parse, ScrollArea, SearchBar, AuthorBadge, ConfirmDialog, or the
 * checkout/revert/reset icons.
 */
export function CommitDetailDialog({
  selectedCommit,
  selectedHash,
  effectiveThreadId,
  projectModeId,
  githubAvatarBySha,
  onClose,
  onAfterAction,
}: Props) {
  const { t } = useTranslation();
  const [commitFiles, setCommitFiles] = useState<CommitFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [commitBody, setCommitBody] = useState<string | null>(null);
  const [fileSearch, setFileSearch] = useState('');
  const [fileSearchCaseSensitive, setFileSearchCaseSensitive] = useState(false);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [diffContent, setDiffContent] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    return Number.isFinite(stored) && stored >= SIDEBAR_MIN_WIDTH && stored <= SIDEBAR_MAX_WIDTH
      ? stored
      : SIDEBAR_DEFAULT_WIDTH;
  });
  const sidebarWidthAtDragStart = useRef(sidebarWidth);
  const { resizing, handlePointerDown, handlePointerMove, handlePointerUp } = useResizeHandle({
    direction: 'horizontal',
    onResizeStart: () => {
      sidebarWidthAtDragStart.current = sidebarWidth;
    },
    onResize: (delta) => {
      const next = Math.max(
        SIDEBAR_MIN_WIDTH,
        Math.min(SIDEBAR_MAX_WIDTH, sidebarWidthAtDragStart.current + delta),
      );
      setSidebarWidth(next);
    },
  });

  useEffect(() => {
    if (resizing) return;
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
  }, [resizing, sidebarWidth]);

  const [checkoutInProgress, setCheckoutInProgress] = useState(false);
  const [revertInProgress, setRevertInProgress] = useState(false);
  const [resetInProgress, setResetInProgress] = useState(false);
  const [confirmCheckoutOpen, setConfirmCheckoutOpen] = useState(false);
  const [confirmRevertOpen, setConfirmRevertOpen] = useState(false);
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);

  const hasGitContext = !!(effectiveThreadId || projectModeId);

  // Load commit files + body when selection changes
  useEffect(() => {
    if (!selectedHash || !hasGitContext) {
      setCommitFiles([]);
      setCommitBody(null);
      setFileSearch('');
      return;
    }
    let cancelled = false;
    setFilesLoading(true);
    setCommitBody(null);
    setFileSearch('');
    (async () => {
      const [filesResult, bodyResult] = await Promise.all([
        effectiveThreadId
          ? api.getCommitFiles(effectiveThreadId, selectedHash)
          : api.projectCommitFiles(projectModeId!, selectedHash),
        effectiveThreadId
          ? api.getCommitBody(effectiveThreadId, selectedHash)
          : api.projectCommitBody(projectModeId!, selectedHash),
      ]);
      if (cancelled) return;
      if (filesResult.isOk()) {
        setCommitFiles(filesResult.value.files);
        if (filesResult.value.files.length > 0) {
          const firstPath = filesResult.value.files[0].path;
          setExpandedFile(firstPath);
          setDiffLoading(true);
          setDiffContent(null);
          const diffResult = effectiveThreadId
            ? await api.getCommitFileDiff(effectiveThreadId, selectedHash, firstPath)
            : await api.projectCommitFileDiff(projectModeId!, selectedHash, firstPath);
          if (!cancelled && diffResult.isOk()) {
            setDiffContent(diffResult.value.diff);
          }
          if (!cancelled) setDiffLoading(false);
        }
      } else {
        toast.error(
          t('review.logFailed', {
            message: filesResult.error.message,
            defaultValue: `Failed to load commit files: ${filesResult.error.message}`,
          }),
        );
        setCommitFiles([]);
      }
      if (bodyResult.isOk() && bodyResult.value.body) {
        setCommitBody(bodyResult.value.body);
      }
      setFilesLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedHash, hasGitContext, effectiveThreadId, projectModeId, t]);

  const handleFileClick = useCallback(
    async (filePath: string) => {
      if (!selectedHash || !hasGitContext) return;
      setExpandedFile(filePath);
      setDiffLoading(true);
      setDiffContent(null);
      const result = effectiveThreadId
        ? await api.getCommitFileDiff(effectiveThreadId, selectedHash, filePath)
        : await api.projectCommitFileDiff(projectModeId!, selectedHash, filePath);
      if (result.isOk()) {
        setDiffContent(result.value.diff);
      } else {
        toast.error(`Failed to load diff: ${result.error.message}`);
      }
      setDiffLoading(false);
    },
    [selectedHash, hasGitContext, effectiveThreadId, projectModeId],
  );

  const treeFiles = useMemo<FileDiffSummary[]>(() => {
    const all = commitFiles.map((f) => ({
      path: f.path,
      status: (f.status === 'copied' ? 'renamed' : f.status) as FileStatus,
      staged: false,
      additions: f.additions,
      deletions: f.deletions,
    }));
    if (!fileSearch.trim()) return all;
    if (fileSearchCaseSensitive) return all.filter((f) => f.path.includes(fileSearch));
    const q = fileSearch.toLowerCase();
    return all.filter((f) => f.path.toLowerCase().includes(q));
  }, [commitFiles, fileSearch, fileSearchCaseSensitive]);

  const historyDiffCache = useMemo(() => {
    const m = new Map<string, string>();
    if (expandedFile && diffContent) m.set(expandedFile, diffContent);
    return m;
  }, [expandedFile, diffContent]);

  const refreshAfterAction = useCallback(() => {
    if (effectiveThreadId) useGitStatusStore.getState().fetchForThread(effectiveThreadId, true);
    else if (projectModeId) useGitStatusStore.getState().fetchProjectStatus(projectModeId, true);
    onAfterAction();
  }, [effectiveThreadId, projectModeId, onAfterAction]);

  const handleCheckoutCommit = useCallback(async () => {
    if (!selectedHash || !hasGitContext || checkoutInProgress) return;
    setCheckoutInProgress(true);
    const result = effectiveThreadId
      ? await api.checkoutCommit(effectiveThreadId, selectedHash)
      : await api.projectCheckoutCommit(projectModeId!, selectedHash);
    if (result.isOk()) {
      toast.success(t('history.checkoutSuccess', 'Switched to commit (detached HEAD)'));
      onClose();
    } else {
      toastError(result.error);
    }
    setCheckoutInProgress(false);
    setConfirmCheckoutOpen(false);
    refreshAfterAction();
  }, [
    selectedHash,
    hasGitContext,
    checkoutInProgress,
    effectiveThreadId,
    projectModeId,
    onClose,
    refreshAfterAction,
    t,
  ]);

  const handleRevertCommit = useCallback(async () => {
    if (!selectedHash || !hasGitContext || revertInProgress) return;
    setRevertInProgress(true);
    const result = effectiveThreadId
      ? await api.revertCommit(effectiveThreadId, selectedHash)
      : await api.projectRevertCommit(projectModeId!, selectedHash);
    if (result.isOk()) {
      toast.success(t('history.revertSuccess', 'Commit reverted successfully'));
      onClose();
    } else {
      toastError(result.error);
    }
    setRevertInProgress(false);
    setConfirmRevertOpen(false);
    refreshAfterAction();
  }, [
    selectedHash,
    hasGitContext,
    revertInProgress,
    effectiveThreadId,
    projectModeId,
    onClose,
    refreshAfterAction,
    t,
  ]);

  const handleResetHard = useCallback(async () => {
    if (!selectedHash || !hasGitContext || resetInProgress) return;
    setResetInProgress(true);
    const result = effectiveThreadId
      ? await api.resetHard(effectiveThreadId, selectedHash)
      : await api.projectResetHard(projectModeId!, selectedHash);
    if (result.isOk()) {
      toast.success(t('history.resetSuccess', 'Branch reset to this commit'));
      onClose();
    } else {
      toastError(result.error);
    }
    setResetInProgress(false);
    setConfirmResetOpen(false);
    refreshAfterAction();
  }, [
    selectedHash,
    hasGitContext,
    resetInProgress,
    effectiveThreadId,
    projectModeId,
    onClose,
    refreshAfterAction,
    t,
  ]);

  const handleClose = () => {
    onClose();
    setExpandedFile(null);
    setDiffContent(null);
  };

  return (
    <>
      <Dialog
        open={!!selectedHash}
        onOpenChange={(open) => {
          if (!open) handleClose();
        }}
      >
        <DialogContent
          className="flex h-[85vh] max-w-[90vw] flex-col gap-0 p-0"
          data-testid="commit-detail-dialog"
        >
          <div className="shrink-0 border-b border-border px-4 py-3">
            <div className="flex items-start justify-between gap-2">
              <DialogTitle className="text-sm font-semibold leading-tight">
                {selectedCommit?.message ?? 'Commit details'}
              </DialogTitle>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={handleClose}
                className="sr-only shrink-0 text-muted-foreground"
                data-testid="commit-detail-close"
              >
                <X className="icon-xs" />
              </Button>
            </div>
            <DialogDescription className="sr-only">
              Commit detail with file changes and diffs
            </DialogDescription>
            {selectedCommit && (
              <div className="flex items-center gap-1.5 pt-1 text-[11px] text-muted-foreground">
                <GitCommit className="icon-xs flex-shrink-0" />
                <code className="flex-shrink-0 font-mono text-primary">
                  {selectedCommit.shortHash}
                </code>
                <AuthorBadge
                  name={selectedCommit.author}
                  email={selectedCommit.authorEmail}
                  avatarUrl={githubAvatarBySha.get(selectedCommit.hash)}
                  size="sm"
                />
                <span className="flex-shrink-0">
                  {shortRelativeDate(selectedCommit.relativeDate)}
                </span>
                <span className="flex-shrink-0 text-muted-foreground">
                  &middot; {commitFiles.length} file{commitFiles.length !== 1 ? 's' : ''}
                </span>
                <div className="ml-auto flex items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => setConfirmCheckoutOpen(true)}
                        disabled={checkoutInProgress}
                        data-testid="commit-checkout-btn"
                      >
                        {checkoutInProgress ? <Loader2 className="animate-spin" /> : <GitBranch />}
                        {t('history.checkout', 'Checkout')}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {t('history.checkoutTooltip', 'Checkout this commit (detached HEAD)')}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => setConfirmRevertOpen(true)}
                        disabled={revertInProgress}
                        data-testid="commit-revert-btn"
                      >
                        {revertInProgress ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                        {t('history.revert', 'Revert')}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {t('history.revertTooltip', 'Undo this commit with a new commit')}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="xs"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setConfirmResetOpen(true)}
                        disabled={resetInProgress}
                        data-testid="commit-reset-btn"
                      >
                        {resetInProgress ? <Loader2 className="animate-spin" /> : <History />}
                        {t('history.reset', 'Reset')}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {t('history.resetTooltip', 'Hard reset branch to this commit')}
                    </TooltipContent>
                  </Tooltip>
                  <div className="mx-1 h-4 w-px bg-border" />
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={handleClose}
                    className="shrink-0 text-muted-foreground"
                    data-testid="commit-detail-close"
                  >
                    <X className="icon-xs" />
                  </Button>
                </div>
              </div>
            )}
            {commitBody && (
              <ScrollArea className="mt-1.5 max-h-[80px]">
                <p className="whitespace-pre-wrap text-[11px] text-muted-foreground">
                  {commitBody}
                </p>
              </ScrollArea>
            )}
          </div>
          {filesLoading ? (
            <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t('review.loading', 'Loading changes…')}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1">
              <div
                className="flex shrink-0 flex-col"
                style={{ width: sidebarWidth }}
                data-testid="commit-detail-file-tree"
              >
                {commitFiles.length > 0 && (
                  <div className="shrink-0 border-b border-sidebar-border px-2 py-1">
                    <SearchBar
                      query={fileSearch}
                      onQueryChange={setFileSearch}
                      placeholder={t('review.searchFiles', 'Filter files…')}
                      totalMatches={treeFiles.length}
                      resultLabel={fileSearch ? `${treeFiles.length}/${commitFiles.length}` : ''}
                      caseSensitive={fileSearchCaseSensitive}
                      onCaseSensitiveChange={setFileSearchCaseSensitive}
                      onClose={fileSearch ? () => setFileSearch('') : undefined}
                      autoFocus={false}
                      testIdPrefix="commit-detail-file-filter"
                    />
                  </div>
                )}
                <ScrollArea className="min-h-0 flex-1">
                  {commitFiles.length === 0 ? (
                    <div className="py-4 text-center text-xs text-muted-foreground">
                      {t('history.noFiles', 'No files changed')}
                    </div>
                  ) : treeFiles.length === 0 ? (
                    <div className="py-4 text-center text-xs text-muted-foreground">
                      {t('history.noMatchingFiles', 'No matching files')}
                    </div>
                  ) : (
                    <FileTree
                      files={treeFiles}
                      selectedFile={expandedFile}
                      onFileClick={handleFileClick}
                      testIdPrefix="commit-detail"
                      searchQuery={fileSearch || undefined}
                    />
                  )}
                </ScrollArea>
              </div>
              <ResizeHandle
                direction="horizontal"
                resizing={resizing}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                data-testid="commit-detail-sidebar-resize"
              />
              <div className="flex min-w-0 flex-1 flex-col" data-testid="commit-detail-diff-pane">
                {!expandedFile ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
                    <FileCode className="size-8 opacity-30" />
                    <p className="text-xs">
                      {t('history.selectFile', 'Select a file to view changes')}
                    </p>
                  </div>
                ) : (
                  <ExpandedDiffView
                    filePath={expandedFile}
                    oldValue={diffContent ? parseDiffOld(diffContent) : ''}
                    newValue={diffContent ? parseDiffNew(diffContent) : ''}
                    loading={diffLoading}
                    rawDiff={diffContent ?? undefined}
                    files={treeFiles}
                    onFileSelect={handleFileClick}
                    diffCache={historyDiffCache}
                  />
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmCheckoutOpen}
        onOpenChange={setConfirmCheckoutOpen}
        title={t('history.confirmCheckoutTitle', 'Checkout Commit')}
        description={t(
          'history.confirmCheckoutDesc',
          'This will switch to a detached HEAD at this commit. Any uncommitted changes may be lost. Continue?',
        )}
        confirmLabel={t('history.confirmCheckoutButton', 'Checkout')}
        onConfirm={handleCheckoutCommit}
        onCancel={() => setConfirmCheckoutOpen(false)}
      />
      <ConfirmDialog
        open={confirmRevertOpen}
        onOpenChange={setConfirmRevertOpen}
        title={t('history.confirmRevertTitle', 'Revert Commit')}
        description={t(
          'history.confirmRevertDesc',
          'This will create a new commit that undoes the changes from this commit. Continue?',
        )}
        confirmLabel={t('history.confirmRevertButton', 'Revert')}
        onConfirm={handleRevertCommit}
        onCancel={() => setConfirmRevertOpen(false)}
      />
      <ConfirmDialog
        open={confirmResetOpen}
        onOpenChange={setConfirmResetOpen}
        title={t('history.confirmResetTitle', 'Hard Reset Branch')}
        description={t(
          'history.confirmResetDesc',
          'Are you sure you want to hard reset the current branch to this commit? This will discard all changes and commits after this point. This action cannot be undone.',
        )}
        confirmLabel={t('history.confirmResetButton', 'Reset Branch')}
        onConfirm={handleResetHard}
        onCancel={() => setConfirmResetOpen(false)}
        variant="destructive"
      />
    </>
  );
}
