import type { FileDiffSummary, FileStatus } from '@funny/shared';
import { FileCode, GitBranch, GitCommit, History, Loader2, RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { AuthorBadge } from '@/components/AuthorBadge';
import { CommitActionConfirm } from '@/components/CommitActionConfirm';
import { FileTree } from '@/components/FileTree';
import { ExpandedDiffView } from '@/components/tool-cards/ExpandedDiffDialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { LoadingState } from '@/components/ui/loading-state';
import { ResizeHandle, useResizeHandle } from '@/components/ui/resize-handle';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SearchBar } from '@/components/ui/search-bar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useCommitActions } from '@/hooks/use-commit-actions';
import { api } from '@/lib/api';
import { copyCommitHashToClipboard } from '@/lib/commit-hash-copy';
import { parseDiffNew, parseDiffOld } from '@/lib/diff-parse';
import { shortRelativeDate } from '@/lib/thread-utils';

interface LogEntry {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  relativeDate: string;
  message: string;
  body: string;
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

  const hasGitContext = !!(effectiveThreadId || projectModeId);

  // Shared checkout / revert / hard-reset logic (also used by the graph context
  // menu). Closes the dialog on success; the confirm UI is <CommitActionConfirm>.
  const { pending, inProgress, request, cancel, confirm } = useCommitActions({
    effectiveThreadId,
    projectModeId,
    onAfterAction,
    onSuccess: onClose,
  });
  const busy = (kind: 'checkout' | 'revert' | 'reset') => inProgress && pending?.kind === kind;

  const handleCopyCommitHash = useCallback(() => {
    if (!selectedCommit) return;
    void copyCommitHashToClipboard(selectedCommit).then(
      (shortHash) =>
        toast.success(
          t('history.hashCopied', {
            hash: shortHash,
            defaultValue: `Copied ${shortHash}`,
          }),
        ),
      () => toast.error(t('history.hashCopyFailed', 'Failed to copy hash')),
    );
  }, [selectedCommit, t]);

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
    setCommitBody(selectedCommit?.body.trim() || null);
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
  }, [selectedHash, selectedCommit?.body, hasGitContext, effectiveThreadId, projectModeId, t]);

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
          <div className="border-border shrink-0 border-b px-4 py-3">
            <div className="flex items-start justify-between gap-2">
              <DialogTitle className="text-sm leading-tight font-semibold">
                {selectedCommit?.message ?? 'Commit details'}
              </DialogTitle>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={handleClose}
                className="text-muted-foreground sr-only shrink-0"
                data-testid="commit-detail-close"
              >
                <X className="icon-xs" />
              </Button>
            </div>
            <DialogDescription className="sr-only">
              Commit detail with file changes and diffs
            </DialogDescription>
            {selectedCommit && (
              <div className="text-muted-foreground flex items-center gap-1.5 pt-1 text-[11px]">
                <GitCommit className="icon-xs shrink-0" />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={handleCopyCommitHash}
                      className="text-primary shrink-0 cursor-pointer border-0 bg-transparent p-0 font-mono hover:underline"
                      data-testid={`commit-detail-hash-${selectedCommit.shortHash}`}
                    >
                      <code>{selectedCommit.shortHash}</code>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {t('history.copyHash', 'Click to copy hash')}
                  </TooltipContent>
                </Tooltip>
                <AuthorBadge
                  name={selectedCommit.author}
                  email={selectedCommit.authorEmail}
                  avatarUrl={githubAvatarBySha.get(selectedCommit.hash)}
                  size="sm"
                />
                <span className="shrink-0">{shortRelativeDate(selectedCommit.relativeDate)}</span>
                <span className="text-muted-foreground shrink-0">
                  &middot; {commitFiles.length} file{commitFiles.length !== 1 ? 's' : ''}
                </span>
                <div className="ml-auto flex items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => selectedHash && request('checkout', selectedHash)}
                        disabled={inProgress}
                        data-testid="commit-checkout-btn"
                      >
                        {busy('checkout') ? <Loader2 className="animate-spin" /> : <GitBranch />}
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
                        onClick={() => selectedHash && request('revert', selectedHash)}
                        disabled={inProgress}
                        data-testid="commit-revert-btn"
                      >
                        {busy('revert') ? <Loader2 className="animate-spin" /> : <RotateCcw />}
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
                        onClick={() => selectedHash && request('reset', selectedHash)}
                        disabled={inProgress}
                        data-testid="commit-reset-btn"
                      >
                        {busy('reset') ? <Loader2 className="animate-spin" /> : <History />}
                        {t('history.reset', 'Reset')}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {t('history.resetTooltip', 'Hard reset branch to this commit')}
                    </TooltipContent>
                  </Tooltip>
                  <div className="bg-border mx-1 h-4 w-px" />
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={handleClose}
                    className="text-muted-foreground shrink-0"
                    data-testid="commit-detail-close"
                  >
                    <X className="icon-xs" />
                  </Button>
                </div>
              </div>
            )}
            {commitBody && (
              <ScrollArea className="mt-1.5 max-h-[80px]">
                <p className="text-muted-foreground text-[11px] whitespace-pre-wrap">
                  {commitBody}
                </p>
              </ScrollArea>
            )}
          </div>
          {filesLoading ? (
            <LoadingState
              testId="commit-detail-loading"
              label={t('review.loading', 'Loading changes…')}
            />
          ) : (
            <div className="flex min-h-0 flex-1">
              <div
                className="flex shrink-0 flex-col"
                style={{ width: sidebarWidth }}
                data-testid="commit-detail-file-tree"
              >
                {commitFiles.length > 0 && (
                  <div className="border-sidebar-border shrink-0 border-b px-2 py-1">
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
                    <div className="text-muted-foreground py-4 text-center text-xs">
                      {t('history.noFiles', 'No files changed')}
                    </div>
                  ) : treeFiles.length === 0 ? (
                    <div className="text-muted-foreground py-4 text-center text-xs">
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
                  <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2">
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

      <CommitActionConfirm pending={pending} onConfirm={confirm} onCancel={cancel} />
    </>
  );
}
