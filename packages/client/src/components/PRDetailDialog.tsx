import type { FileDiffSummary, GitHubPR, PRCommit, PRDetail, PRFile } from '@funny/shared';
import { FileCode, GitCommitHorizontal, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { LoadingState } from '@/components/ui/loading-state';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SearchBar } from '@/components/ui/search-bar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { usePRDetail, usePRDetailStore } from '@/stores/pr-detail-store';

import { DiffStats } from './DiffStats';
import { FileTree } from './FileTree';
import { PinnedPRCard } from './PinnedPRCard';
import { PRCompactIdentity } from './pull-requests/PRCompactIdentity';
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
  currentUserLogin?: string;
}

interface PRDetailInfoTabProps {
  commits: PRCommit[];
  selectedCommit: string;
  onSelectedCommitChange: (value: string) => void;
  totalAdditions: number;
  totalDeletions: number;
  displayedFiles: PRFile[];
  filteredFiles: PRFile[];
  fileSummaries: FileDiffSummary[];
  isLoading: boolean;
  error: string | null;
  loadingCommitFiles: boolean;
  fileSearch: string;
  onFileSearchChange: (value: string) => void;
  fileSearchCaseSensitive: boolean;
  onFileSearchCaseSensitiveChange: (value: boolean) => void;
  selectedFile: string | null;
  onSelectedFileChange: (filePath: string | null) => void;
  onRevertFile: (filePath: string) => Promise<void>;
  diffCache: Map<string, string>;
  onRequestFullDiff: (
    filePath: string,
  ) => Promise<{ oldValue: string; newValue: string; rawDiff?: string } | null>;
}

function PRDetailInfoTab({
  commits,
  selectedCommit,
  onSelectedCommitChange,
  totalAdditions,
  totalDeletions,
  displayedFiles,
  filteredFiles,
  fileSummaries,
  isLoading,
  error,
  loadingCommitFiles,
  fileSearch,
  onFileSearchChange,
  fileSearchCaseSensitive,
  onFileSearchCaseSensitiveChange,
  selectedFile,
  onSelectedFileChange,
  onRevertFile,
  diffCache,
  onRequestFullDiff,
}: PRDetailInfoTabProps) {
  return (
    <TabsContent value="info" className="mt-0 flex min-h-0 flex-1 flex-col">
      <div className="border-border flex shrink-0 items-center gap-2 border-b px-4 py-2">
        <Select value={selectedCommit} onValueChange={onSelectedCommitChange}>
          <SelectTrigger
            className="h-6 w-auto max-w-[400px] text-[11px]"
            data-testid="pr-detail-commit-select"
          >
            <GitCommitHorizontal className="text-muted-foreground mr-1 size-3 shrink-0" />
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
                  <span className="text-muted-foreground text-[10px]">
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

      {isLoading ? (
        <LoadingState testId="pr-detail-loading" label="Loading PR data…" />
      ) : error ? (
        <div className="text-muted-foreground flex flex-1 items-center justify-center text-xs">
          {error}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div
            className="border-border flex w-[280px] shrink-0 flex-col border-r"
            data-testid="pr-detail-file-tree"
          >
            {displayedFiles.length > 0 && (
              <div className="border-sidebar-border shrink-0 border-b px-2 py-1">
                <SearchBar
                  query={fileSearch}
                  onQueryChange={onFileSearchChange}
                  placeholder="Filter files…"
                  totalMatches={filteredFiles.length}
                  resultLabel={fileSearch ? `${filteredFiles.length}/${displayedFiles.length}` : ''}
                  caseSensitive={fileSearchCaseSensitive}
                  onCaseSensitiveChange={onFileSearchCaseSensitiveChange}
                  onClose={fileSearch ? () => onFileSearchChange('') : undefined}
                  autoFocus={false}
                  testIdPrefix="pr-detail-file-filter"
                />
              </div>
            )}

            <ScrollArea className="min-h-0 flex-1">
              {loadingCommitFiles ? (
                <LoadingState testId="pr-detail-files-loading" label="Loading…" />
              ) : fileSummaries.length === 0 ? (
                <div className="text-muted-foreground py-4 text-center text-xs">
                  {fileSearch ? 'No matching files' : 'No files changed'}
                </div>
              ) : (
                <FileTree
                  files={fileSummaries}
                  selectedFile={selectedFile}
                  onFileClick={onSelectedFileChange}
                  onRevertFile={onRevertFile}
                  revertLabel="Revert to base"
                  diffStatsSize="xxs"
                  searchQuery={fileSearch}
                  testIdPrefix="pr-detail"
                />
              )}
            </ScrollArea>
          </div>

          <div className="flex min-w-0 flex-1 flex-col" data-testid="pr-detail-diff-pane">
            {!selectedFile ? (
              <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2">
                <FileCode className="size-8 opacity-30" />
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
                onFileSelect={onSelectedFileChange}
                onRequestFullDiff={onRequestFullDiff}
              />
            )}
          </div>
        </div>
      )}
    </TabsContent>
  );
}

function PRDetailHeader({
  pr,
  detail,
  commitCount,
  totalAdditions,
  totalDeletions,
  changedFiles,
  onClose,
}: {
  pr: GitHubPR;
  detail?: PRDetail;
  commitCount: number;
  totalAdditions: number;
  totalDeletions: number;
  changedFiles: number;
  onClose: () => void;
}) {
  const headerPr = detail
    ? {
        ...pr,
        ...detail,
        head: {
          ...pr.head,
          ...detail.head,
        },
        base: {
          ...pr.base,
          ...detail.base,
        },
      }
    : commitCount > 0
      ? { ...pr, commits: commitCount }
      : pr;
  const stats = detail
    ? {
        additions: detail.additions,
        deletions: detail.deletions,
        changedFiles: detail.changed_files,
      }
    : changedFiles > 0
      ? {
          additions: totalAdditions,
          deletions: totalDeletions,
          changedFiles,
        }
      : null;

  return (
    <div className="border-border shrink-0 border-b px-4 py-3">
      <DialogTitle className="sr-only">{pr.title}</DialogTitle>
      <DialogDescription className="sr-only">
        Pull request detail with file changes and diffs
      </DialogDescription>
      <PRCompactIdentity
        pr={headerPr}
        showStateBadge
        numberTestId="pr-detail-badge"
        titleTestId="pr-detail-title"
        mergeLineTestId="pr-detail-merge-line"
        statusTestId="pr-detail-status"
        stats={stats}
        reviewDecision={detail?.review_decision}
        mergeableState={detail?.mergeable_state}
        titleExtra={
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onClose}
            className="text-muted-foreground shrink-0"
            data-testid="pr-detail-close"
          >
            <X className="icon-xs" />
          </Button>
        }
      />
    </div>
  );
}

export function PRDetailDialog({
  open,
  onOpenChange,
  projectId,
  pr,
  currentUserLogin,
}: PRDetailDialogProps) {
  const prNumber = pr.number;
  const { detail } = usePRDetail(projectId, prNumber);
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
  const [activeTab, setActiveTab] = useState<'info' | 'conversation'>('info');

  // Fetch data when dialog opens
  useEffect(() => {
    if (!open) return;
    void usePRDetailStore.getState().fetchPRDetail(projectId, prNumber);
    setError(null);
    setSelectedFile(null);
    setSelectedCommit('all');
    setCommitFiles(null);
    setActiveTab('info');

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
        <PRDetailHeader
          pr={pr}
          detail={detail}
          commitCount={commits.length}
          totalAdditions={totalAdditions}
          totalDeletions={totalDeletions}
          changedFiles={displayedFiles.length}
          onClose={() => onOpenChange(false)}
        />

        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as 'info' | 'conversation')}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="border-border shrink-0 border-b px-4 py-2">
            <TabsList className="h-7 rounded-md p-0.5" data-testid="pr-detail-tabs">
              <TabsTrigger
                value="info"
                onClick={() => setActiveTab('info')}
                data-testid="pr-detail-tab-info"
              >
                Info
              </TabsTrigger>
              <TabsTrigger
                value="conversation"
                onClick={() => setActiveTab('conversation')}
                data-testid="pr-detail-tab-conversation"
              >
                Conversation
              </TabsTrigger>
            </TabsList>
          </div>

          <PRDetailInfoTab
            commits={commits}
            selectedCommit={selectedCommit}
            onSelectedCommitChange={setSelectedCommit}
            totalAdditions={totalAdditions}
            totalDeletions={totalDeletions}
            displayedFiles={displayedFiles}
            filteredFiles={filteredFiles}
            fileSummaries={fileSummaries}
            isLoading={isLoading}
            error={error}
            loadingCommitFiles={loadingCommitFiles}
            fileSearch={fileSearch}
            onFileSearchChange={setFileSearch}
            fileSearchCaseSensitive={fileSearchCaseSensitive}
            onFileSearchCaseSensitiveChange={setFileSearchCaseSensitive}
            selectedFile={selectedFile}
            onSelectedFileChange={setSelectedFile}
            onRevertFile={handleRevertFile}
            diffCache={diffCache}
            onRequestFullDiff={handleRequestFullDiff}
          />

          <TabsContent value="conversation" className="mt-0 min-h-0 flex-1">
            <ScrollArea className="h-full">
              <div className="pr-detail-conversation p-4">
                <style>
                  {
                    '.pr-detail-conversation [data-testid^="pinned-pr-card-"] > div:first-child { display: none; }'
                  }
                </style>
                {activeTab === 'conversation' ? (
                  <PinnedPRCard pr={pr} projectId={projectId} currentUserLogin={currentUserLogin} />
                ) : null}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
