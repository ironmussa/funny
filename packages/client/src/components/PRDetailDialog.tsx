import type { FileDiffSummary, GitHubPR, PRCommit, PRFile } from '@funny/shared';
import { FileCode, GitCommitHorizontal, Loader2, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SearchBar } from '@/components/ui/search-bar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';

import { BranchBadge } from './BranchBadge';
import { DiffStats } from './DiffStats';
import { FileTree } from './FileTree';
import { PRBadge } from './PRBadge';
import { PRStateBadge } from './PRSummaryCard';
import { ExpandedDiffView } from './tool-cards/ExpandedDiffDialog';

const log = createClientLogger('pr-detail-dialog');

// ── Helpers ──

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function firstLine(message: string): string {
  return message.split('\n')[0];
}

/** Convert PRFile[] to FileDiffSummary[] so we can reuse the existing FileTree component. */
function toFileDiffSummaries(files: PRFile[]): FileDiffSummary[] {
  return files.map((f) => ({
    path: f.filename,
    status:
      f.status === 'removed'
        ? 'deleted'
        : f.status === 'renamed' || f.status === 'copied'
          ? 'renamed'
          : f.status === 'added'
            ? 'added'
            : 'modified',
    staged: false,
    additions: f.additions,
    deletions: f.deletions,
  }));
}

// ── Component ──

interface PRDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  pr: GitHubPR;
}

export function PRDetailDialog({ open, onOpenChange, projectId, pr }: PRDetailDialogProps) {
  const prNumber = pr.number;
  const prTitle = pr.title;
  const prUrl = pr.html_url;
  // Data state
  const [files, setFiles] = useState<PRFile[]>([]);
  const [commits, setCommits] = useState<PRCommit[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadingCommits, setLoadingCommits] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // UI state
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<string>('all');
  const [commitFiles, setCommitFiles] = useState<PRFile[] | null>(null);
  const [loadingCommitFiles, setLoadingCommitFiles] = useState(false);
  const [fileSearch, setFileSearch] = useState('');
  const [fileSearchCaseSensitive, setFileSearchCaseSensitive] = useState(false);

  // Fetch data when dialog opens
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSelectedFile(null);
    setSelectedCommit('all');
    setCommitFiles(null);

    const loadData = async () => {
      setLoadingFiles(true);
      setLoadingCommits(true);

      const [filesResult, commitsResult] = await Promise.all([
        api.githubPRFiles(projectId, prNumber),
        api.githubPRCommits(projectId, prNumber),
      ]);

      if (filesResult.isOk()) {
        setFiles(filesResult.value.files);
        if (filesResult.value.files.length > 0) {
          setSelectedFile(filesResult.value.files[0].filename);
        }
      } else {
        log.error('Failed to fetch PR files', { error: filesResult.error });
        setError(filesResult.error.message || 'Failed to load PR files');
      }
      setLoadingFiles(false);

      if (commitsResult.isOk()) {
        setCommits(commitsResult.value.commits);
      } else {
        log.error('Failed to fetch PR commits', { error: commitsResult.error });
      }
      setLoadingCommits(false);
    };

    loadData();
  }, [open, projectId, prNumber]);

  // Fetch files for a specific commit
  useEffect(() => {
    if (selectedCommit === 'all') {
      setCommitFiles(null);
      return;
    }

    let cancelled = false;
    setLoadingCommitFiles(true);
    api.githubPRFiles(projectId, prNumber, selectedCommit).then((result) => {
      if (cancelled) return;
      if (result.isOk()) {
        setCommitFiles(result.value.files);
      } else {
        log.error('Failed to fetch commit files', { error: result.error });
        setCommitFiles([]);
      }
      setLoadingCommitFiles(false);
    });

    return () => {
      cancelled = true;
    };
  }, [selectedCommit, projectId, prNumber]);

  const displayedFiles = commitFiles ?? files;
  const filteredFiles = useMemo(() => {
    if (!fileSearch) return displayedFiles;
    if (fileSearchCaseSensitive) {
      return displayedFiles.filter((f) => f.filename.includes(fileSearch));
    }
    const q = fileSearch.toLowerCase();
    return displayedFiles.filter((f) => f.filename.toLowerCase().includes(q));
  }, [displayedFiles, fileSearch, fileSearchCaseSensitive]);
  const fileSummaries = useMemo(() => toFileDiffSummaries(filteredFiles), [filteredFiles]);

  // Revert a file to its base branch state
  const handleRevertFile = useCallback(
    async (filePath: string) => {
      const result = await api.githubPRRevertFile(projectId, prNumber, filePath);
      if (result.isOk()) {
        const action = result.value.action === 'deleted' ? 'removed' : 'reverted to base';
        toast.success(`${filePath} ${action}`);
        // Re-fetch files to reflect the change
        const refreshed = await api.githubPRFiles(
          projectId,
          prNumber,
          selectedCommit !== 'all' ? selectedCommit : undefined,
        );
        if (refreshed.isOk()) {
          if (selectedCommit === 'all') {
            setFiles(refreshed.value.files);
          } else {
            setCommitFiles(refreshed.value.files);
          }
        }
        if (selectedFile === filePath) setSelectedFile(null);
      } else {
        log.error('Failed to revert file', { error: result.error });
        toast.error(result.error.message || 'Failed to revert file');
      }
    },
    [projectId, prNumber, selectedCommit, selectedFile],
  );

  // Build a diff cache from patches so ExpandedDiffView can look up diffs by file path
  const diffCache = useMemo(() => {
    const cache = new Map<string, string>();
    for (const f of displayedFiles) {
      if (f.patch) {
        cache.set(f.filename, `--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}`);
      }
    }
    return cache;
  }, [displayedFiles]);

  // Fetch full file content for ExpandedDiffView's "show full file" feature
  const handleRequestFullDiff = useCallback(
    async (filePath: string) => {
      const result = await api.githubPRFileContent(projectId, prNumber, filePath);
      if (result.isErr()) {
        log.error('Failed to fetch full file', { error: result.error });
        toast.error('Failed to load full file');
        return null;
      }
      const { baseContent, headContent } = result.value;
      const file = displayedFiles.find((f) => f.filename === filePath);
      const rawDiff = file?.patch
        ? `--- a/${filePath}\n+++ b/${filePath}\n${file.patch}`
        : undefined;
      return { oldValue: baseContent, newValue: headContent, rawDiff };
    },
    [projectId, prNumber, displayedFiles],
  );

  const totalAdditions = useMemo(
    () => displayedFiles.reduce((s, f) => s + f.additions, 0),
    [displayedFiles],
  );
  const totalDeletions = useMemo(
    () => displayedFiles.reduce((s, f) => s + f.deletions, 0),
    [displayedFiles],
  );

  const isLoading = loadingFiles || loadingCommits;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[85vh] max-w-[90vw] flex-col gap-0 p-0"
        data-testid="pr-detail-dialog"
      >
        {/* ── Header ── */}
        <div className="shrink-0 border-b border-border px-4 py-3">
          {/* Row 1: Title + close button */}
          <div className="flex items-start justify-between gap-2">
            <DialogTitle className="text-sm font-semibold leading-tight">{prTitle}</DialogTitle>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => onOpenChange(false)}
              className="shrink-0 text-muted-foreground"
              data-testid="pr-detail-close"
            >
              <X className="icon-xs" />
            </Button>
          </div>
          <DialogDescription className="sr-only">
            Pull request detail with file changes and diffs
          </DialogDescription>

          {/* Row 2: author wants to merge N commits into [base] from [head] + PR badge + State badge */}
          <div className="flex flex-wrap items-center gap-1.5 pt-1.5 text-[11px]">
            <span className="text-muted-foreground">
              <span className="font-medium text-foreground">{pr.user?.login ?? 'unknown'}</span>
              {' wants to merge '}
              {commits.length > 0 ? (
                <>
                  {commits.length} commit{commits.length !== 1 ? 's' : ''}
                </>
              ) : (
                'commits'
              )}
              {' into '}
            </span>
            <BranchBadge branch={pr.base.ref} size="xs" />
            <span className="text-muted-foreground">from</span>
            <BranchBadge branch={pr.head.ref} size="xs" />
            <PRBadge
              prNumber={prNumber}
              prState={pr.merged_at ? 'MERGED' : pr.state === 'closed' ? 'CLOSED' : 'OPEN'}
              prUrl={prUrl}
              size="xxs"
              data-testid="pr-detail-badge"
            />
            <PRStateBadge state={pr.state} draft={pr.draft} merged={!!pr.merged_at} />
          </div>

          {/* Row 3: Commit selector + DiffStats */}
          <div className="flex items-center gap-2 pt-1">
            <Select value={selectedCommit} onValueChange={setSelectedCommit}>
              <SelectTrigger
                className="h-6 w-auto max-w-[400px] text-[11px]"
                data-testid="pr-detail-commit-select"
              >
                <GitCommitHorizontal className="mr-1 h-3 w-3 shrink-0 text-muted-foreground" />
                <SelectValue placeholder="All commits">
                  {selectedCommit === 'all' ? (
                    <span className="text-[11px]">All commits ({commits.length})</span>
                  ) : (
                    <span className="truncate text-[11px]">
                      {firstLine(
                        commits.find((c) => c.sha === selectedCommit)?.message ?? selectedCommit,
                      )}
                    </span>
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent className="max-w-[480px]">
                <SelectItem value="all" data-testid="pr-detail-commit-all">
                  <span className="text-[11px]">All commits ({commits.length})</span>
                </SelectItem>
                {commits.map((c) => (
                  <SelectItem
                    key={c.sha}
                    value={c.sha}
                    data-testid={`pr-detail-commit-${shortSha(c.sha)}`}
                  >
                    <div className="flex flex-col gap-0.5 py-0.5">
                      <span className="truncate text-[11px]">{firstLine(c.message)}</span>
                      <span className="text-[10px] text-muted-foreground">
                        <span className="font-mono">{shortSha(c.sha)}</span>
                        {c.author?.login && <> &middot; {c.author.login}</>}
                        {c.date && <> &middot; {new Date(c.date).toLocaleDateString()}</>}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <DiffStats
              linesAdded={totalAdditions}
              linesDeleted={totalDeletions}
              dirtyFileCount={displayedFiles.length}
              variant="pr"
              size="xxs"
              tooltips
            />
          </div>
        </div>

        {/* ── Body ── */}
        {isLoading ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading PR data...
          </div>
        ) : error ? (
          <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
            {error}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            {/* ── File tree sidebar (reuses existing FileTree component) ── */}
            <div
              className="flex w-[280px] shrink-0 flex-col border-r border-border"
              data-testid="pr-detail-file-tree"
            >
              {/* File search */}
              {displayedFiles.length > 0 && (
                <div className="shrink-0 border-b border-sidebar-border px-2 py-1">
                  <SearchBar
                    query={fileSearch}
                    onQueryChange={setFileSearch}
                    placeholder="Filter files…"
                    totalMatches={filteredFiles.length}
                    resultLabel={
                      fileSearch ? `${filteredFiles.length}/${displayedFiles.length}` : ''
                    }
                    caseSensitive={fileSearchCaseSensitive}
                    onCaseSensitiveChange={setFileSearchCaseSensitive}
                    onClose={fileSearch ? () => setFileSearch('') : undefined}
                    autoFocus={false}
                    testIdPrefix="pr-detail-file-filter"
                  />
                </div>
              )}

              <ScrollArea className="min-h-0 flex-1">
                {loadingCommitFiles ? (
                  <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading...
                  </div>
                ) : fileSummaries.length === 0 ? (
                  <div className="py-4 text-center text-xs text-muted-foreground">
                    {fileSearch ? 'No matching files' : 'No files changed'}
                  </div>
                ) : (
                  <FileTree
                    files={fileSummaries}
                    selectedFile={selectedFile}
                    onFileClick={setSelectedFile}
                    onRevertFile={handleRevertFile}
                    revertLabel="Revert to base"
                    diffStatsSize="xxs"
                    searchQuery={fileSearch}
                    testIdPrefix="pr-detail"
                  />
                )}
              </ScrollArea>
            </div>

            {/* ── Diff viewer ── */}
            <div className="flex min-w-0 flex-1 flex-col" data-testid="pr-detail-diff-pane">
              {!selectedFile ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
                  <FileCode className="h-8 w-8 opacity-30" />
                  <p className="text-xs">Select a file to view changes</p>
                </div>
              ) : (
                <ExpandedDiffView
                  filePath={selectedFile}
                  oldValue=""
                  newValue=""
                  rawDiff={diffCache.get(selectedFile)}
                  files={fileSummaries}
                  diffCache={diffCache}
                  onFileSelect={setSelectedFile}
                  onRequestFullDiff={handleRequestFullDiff}
                />
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
