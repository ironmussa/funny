import type { FileDiffSummary, FileStatus } from '@funny/shared';
import { FileCode, GitBranch, GitCommit, History, Loader2, RotateCcw, X } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { AuthorBadge } from '@/components/AuthorBadge';
import { CommitActionConfirm } from '@/components/CommitActionConfirm';
import { FileTree } from '@/components/FileTree';
import { ExpandedDiffView } from '@/components/tool-cards/ExpandedDiffDialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingState } from '@/components/ui/loading-state';
import { ResizeHandle, useResizeHandle } from '@/components/ui/resize-handle';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SearchBar } from '@/components/ui/search-bar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useCommitActions } from '@/hooks/use-commit-actions';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { useAdjustOnChange } from '@/hooks/use-resettable-state';
import { api } from '@/lib/api';
import { copyCommitHashToClipboard } from '@/lib/commit-hash-copy';
import { parseDiffNew, parseDiffOld } from '@/lib/diff-parse';
import { shortTimeAgo } from '@/lib/thread-utils';
import { whilePending, withCleanup } from '@/lib/while-pending';

interface LogEntry {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  authoredAt: number;
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

function useSidebarWidth() {
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

  return { sidebarWidth, resizing, handlePointerDown, handlePointerMove, handlePointerUp };
}

interface CommitDetailDataArgs {
  selectedCommit: LogEntry | undefined;
  selectedHash: string | null;
  effectiveThreadId: string | undefined;
  projectModeId: string | null;
}

/** Loaded files / commit body / file search / diff content of the selected commit. */
function useCommitDetailData({
  selectedCommit,
  selectedHash,
  effectiveThreadId,
  projectModeId,
}: CommitDetailDataArgs) {
  const { t } = useTranslation();
  const hasGitContext = !!(effectiveThreadId || projectModeId);
  const willLoad = !!selectedHash && hasGitContext;
  const initialBody = willLoad ? selectedCommit?.body.trim() || null : null;
  const [commitFiles, setCommitFiles] = useState<CommitFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(willLoad);
  const [commitBody, setCommitBody] = useState<string | null>(initialBody);
  const [fileSearch, setFileSearch] = useState('');
  const [fileSearchCaseSensitive, setFileSearchCaseSensitive] = useState(false);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [diffContent, setDiffContent] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  // A new selection resets what the previous one loaded during render (React's
  // "adjusting state when a prop changes"); the effect below only fetches.
  useAdjustOnChange(
    [selectedHash, selectedCommit?.body, hasGitContext, effectiveThreadId, projectModeId],
    () => {
      if (willLoad) setFilesLoading(true);
      else setCommitFiles([]);
      setCommitBody(initialBody);
      setFileSearch('');
    },
  );

  // Load commit files + body when selection changes
  // Async writes are owned by this selection and ignored after cleanup flips cancelled.
  // react-doctor-disable-next-line react-doctor/no-set-state-after-await-in-effect
  useEffect(() => {
    if (!selectedHash || !hasGitContext) return;
    let cancelled = false;
    (async () => {
      return withCleanup(
        async () => {
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
              await withCleanup(
                async () => {
                  const diffResult = effectiveThreadId
                    ? await api.getCommitFileDiff(effectiveThreadId, selectedHash, firstPath)
                    : await api.projectCommitFileDiff(projectModeId!, selectedHash, firstPath);
                  if (!cancelled && diffResult.isOk()) setDiffContent(diffResult.value.diff);
                },
                () => {
                  // The nested request clears its flag once settled, and only while this selection owns it.
                  // react-doctor-disable-next-line react-doctor/no-loading-flag-reset-outside-finally
                  if (!cancelled) setDiffLoading(false);
                },
              );
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
          if (bodyResult.isOk() && bodyResult.value.body) setCommitBody(bodyResult.value.body);
        },
        () => {
          if (!cancelled) setFilesLoading(false);
        },
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedHash, selectedCommit?.body, hasGitContext, effectiveThreadId, projectModeId, t]);

  const handleFileClick = useCallback(
    async (filePath: string) => {
      if (!selectedHash || !hasGitContext) return;
      setExpandedFile(filePath);
      return whilePending(setDiffLoading, async () => {
        setDiffContent(null);
        const result = effectiveThreadId
          ? await api.getCommitFileDiff(effectiveThreadId, selectedHash, filePath)
          : await api.projectCommitFileDiff(projectModeId!, selectedHash, filePath);
        if (result.isOk()) setDiffContent(result.value.diff);
        else toast.error(`Failed to load diff: ${result.error.message}`);
      });
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

  const resetDiff = () => {
    setExpandedFile(null);
    setDiffContent(null);
  };

  return {
    commitFiles,
    filesLoading,
    commitBody,
    fileSearch,
    setFileSearch,
    fileSearchCaseSensitive,
    setFileSearchCaseSensitive,
    expandedFile,
    diffContent,
    diffLoading,
    handleFileClick,
    treeFiles,
    historyDiffCache,
    resetDiff,
  };
}

type CommitDetailData = ReturnType<typeof useCommitDetailData>;
type CommitActions = ReturnType<typeof useCommitActions>;
type HeaderActionKind = 'checkout' | 'revert' | 'reset';

interface CommitActionButtonProps {
  kind: HeaderActionKind;
  actions: CommitActions;
  selectedHash: string | null;
  variant: 'ghost' | 'ghost-destructive';
  icon: ReactNode;
  label: string;
  tooltip: string;
  testId: string;
}

function CommitActionButton({
  kind,
  actions,
  selectedHash,
  variant,
  icon,
  label,
  tooltip,
  testId,
}: CommitActionButtonProps) {
  const { pending, inProgress, request } = actions;
  const busy = inProgress && pending?.kind === kind;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={variant}
          size="xs"
          onClick={() => selectedHash && request(kind, selectedHash)}
          disabled={inProgress}
          data-testid={testId}
        >
          {busy ? <Loader2 className="animate-spin" /> : icon}
          {label}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

interface CommitMetaRowProps {
  selectedCommit: LogEntry;
  selectedHash: string | null;
  fileCount: number;
  githubAvatarBySha: Map<string, string>;
  actions: CommitActions;
  onClose: () => void;
}

function CommitMetaRow({
  selectedCommit,
  selectedHash,
  fileCount,
  githubAvatarBySha,
  actions,
  onClose,
}: CommitMetaRowProps) {
  const { t } = useTranslation();
  const now = useMinuteTick();

  const handleCopyCommitHash = useCallback(() => {
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

  return (
    <div className="text-muted-foreground text-compact flex items-center gap-1.5 pt-1">
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
        <TooltipContent side="bottom">{t('history.copyHash', 'Click to copy hash')}</TooltipContent>
      </Tooltip>
      <AuthorBadge
        name={selectedCommit.author}
        email={selectedCommit.authorEmail}
        avatarUrl={githubAvatarBySha.get(selectedCommit.hash)}
        size="sm"
      />
      <span className="shrink-0">{shortTimeAgo(selectedCommit.authoredAt, now)}</span>
      <span className="text-muted-foreground shrink-0">
        &middot; {fileCount} file{fileCount !== 1 ? 's' : ''}
      </span>
      <div className="ml-auto flex items-center gap-1">
        <CommitActionButton
          kind="checkout"
          actions={actions}
          selectedHash={selectedHash}
          variant="ghost"
          icon={<GitBranch />}
          label={t('history.checkout', 'Checkout')}
          tooltip={t('history.checkoutTooltip', 'Checkout this commit (detached HEAD)')}
          testId="commit-checkout-btn"
        />
        <CommitActionButton
          kind="revert"
          actions={actions}
          selectedHash={selectedHash}
          variant="ghost"
          icon={<RotateCcw />}
          label={t('history.revert', 'Revert')}
          tooltip={t('history.revertTooltip', 'Undo this commit with a new commit')}
          testId="commit-revert-btn"
        />
        <CommitActionButton
          kind="reset"
          actions={actions}
          selectedHash={selectedHash}
          variant="ghost-destructive"
          icon={<History />}
          label={t('history.reset', 'Reset')}
          tooltip={t('history.resetTooltip', 'Hard reset branch to this commit')}
          testId="commit-reset-btn"
        />
        <div className="bg-border mx-1 h-4 w-px" />
        <Button
          variant="muted"
          size="icon-xs"
          onClick={onClose}
          className="shrink-0"
          data-testid="commit-detail-close"
        >
          <X className="icon-xs" />
        </Button>
      </div>
    </div>
  );
}

interface CommitDetailHeaderProps extends Omit<CommitMetaRowProps, 'selectedCommit'> {
  selectedCommit: LogEntry | undefined;
  commitBody: string | null;
}

function CommitDetailHeader({ selectedCommit, commitBody, ...rowProps }: CommitDetailHeaderProps) {
  return (
    <div className="border-border shrink-0 border-b px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <DialogTitle size="sm" className="leading-tight">
          {selectedCommit?.message ?? 'Commit details'}
        </DialogTitle>
        <Button
          variant="muted"
          size="icon-xs"
          onClick={rowProps.onClose}
          className="sr-only shrink-0"
          data-testid="commit-detail-close"
        >
          <X className="icon-xs" />
        </Button>
      </div>
      <DialogDescription className="sr-only">
        Commit detail with file changes and diffs
      </DialogDescription>
      {selectedCommit && <CommitMetaRow selectedCommit={selectedCommit} {...rowProps} />}
      {commitBody && (
        <ScrollArea className="mt-1.5 max-h-[80px]">
          <p className="text-muted-foreground text-compact whitespace-pre-wrap">{commitBody}</p>
        </ScrollArea>
      )}
    </div>
  );
}

function CommitFileSidebar({ data, width }: { data: CommitDetailData; width: number }) {
  const { t } = useTranslation();
  const {
    commitFiles,
    treeFiles,
    fileSearch,
    setFileSearch,
    fileSearchCaseSensitive,
    setFileSearchCaseSensitive,
    expandedFile,
    handleFileClick,
  } = data;
  return (
    <div className="flex shrink-0 flex-col" style={{ width }} data-testid="commit-detail-file-tree">
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
          <EmptyState fill={false} title={t('history.noFiles', 'No files changed')} />
        ) : treeFiles.length === 0 ? (
          <EmptyState fill={false} title={t('history.noMatchingFiles', 'No matching files')} />
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
  );
}

function CommitDiffPane({ data }: { data: CommitDetailData }) {
  const { t } = useTranslation();
  const { expandedFile, diffContent, diffLoading, treeFiles, handleFileClick, historyDiffCache } =
    data;
  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="commit-detail-diff-pane">
      {!expandedFile ? (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2">
          <FileCode className="size-8 opacity-30" />
          <p className="text-xs">{t('history.selectFile', 'Select a file to view changes')}</p>
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
  );
}

/**
 * Modal that opens when the user clicks a commit row: shows commit metadata,
 * a filtered file tree on the left, the diff for the selected file on the
 * right, plus checkout/revert/reset actions (each gated by a ConfirmDialog).
 *
 * Owns its own loaded-files / commit-body / file-search / diff-content
 * state and the 3 destructive-action handlers, so its parent doesn't have
 * to import the Dialog cluster, FileTree, ExpandedDiffView,
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
  const { sidebarWidth, resizing, handlePointerDown, handlePointerMove, handlePointerUp } =
    useSidebarWidth();
  const data = useCommitDetailData({
    selectedCommit,
    selectedHash,
    effectiveThreadId,
    projectModeId,
  });

  // Shared checkout / revert / hard-reset logic (also used by the graph context
  // menu). Closes the dialog on success; the confirm UI is <CommitActionConfirm>.
  const actions = useCommitActions({
    effectiveThreadId,
    projectModeId,
    onAfterAction,
    onSuccess: onClose,
  });

  const handleClose = () => {
    onClose();
    data.resetDiff();
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
          flush
          className="flex h-[85vh] max-w-[90vw] flex-col"
          data-testid="commit-detail-dialog"
        >
          <CommitDetailHeader
            selectedCommit={selectedCommit}
            selectedHash={selectedHash}
            commitBody={data.commitBody}
            fileCount={data.commitFiles.length}
            githubAvatarBySha={githubAvatarBySha}
            actions={actions}
            onClose={handleClose}
          />
          {data.filesLoading ? (
            <LoadingState
              testId="commit-detail-loading"
              label={t('review.loading', 'Loading changes…')}
            />
          ) : (
            <div className="flex min-h-0 flex-1">
              <CommitFileSidebar data={data} width={sidebarWidth} />
              <ResizeHandle
                direction="horizontal"
                resizing={resizing}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                data-testid="commit-detail-sidebar-resize"
              />
              <CommitDiffPane data={data} />
            </div>
          )}
        </DialogContent>
      </Dialog>

      <CommitActionConfirm
        pending={actions.pending}
        onConfirm={actions.confirm}
        onCancel={actions.cancel}
      />
    </>
  );
}
