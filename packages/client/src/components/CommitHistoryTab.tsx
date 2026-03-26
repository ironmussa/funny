import type { FileDiffSummary, FileStatus } from '@funny/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { GitCommit, Loader2, RefreshCw, Search, X } from 'lucide-react';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { HighlightText } from '@/components/ui/highlight-text';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

import { FileTree } from './FileTree';
import { ExpandedDiffDialog } from './tool-cards/ExpandedDiffDialog';

// ── Types ──

interface LogEntry {
  hash: string;
  shortHash: string;
  author: string;
  relativeDate: string;
  message: string;
}

interface CommitFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

// ── Constants ──

const PAGE_SIZE = 50;
const COMMIT_ROW_HEIGHT = 58; // ~px per commit row
const SELECTED_COMMIT_KEY = 'history_selected_commit';

// ── Helpers ──

function parseDiffOld(unifiedDiff: string): string {
  const lines = unifiedDiff.split('\n');
  const oldLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) continue;
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
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) {
      newLines.push(line.substring(1));
    } else if (!line.startsWith('-')) {
      newLines.push(line);
    }
  }
  return newLines.join('\n');
}

function getFileName(filePath: string): string {
  return filePath.split('/').pop() || filePath;
}

// ── Component ──

export function CommitHistoryTab() {
  const { t } = useTranslation();
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const effectiveThreadId = useThreadStore((s) => s.activeThread?.id);
  const projectModeId = !effectiveThreadId ? selectedProjectId : null;
  const hasGitContext = !!(effectiveThreadId || projectModeId);

  // Log entries (accumulated across pages)
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const loadedRef = useRef(false);
  const loadingRef = useRef(false);

  // Selected commit (persisted per git context)
  const [selectedHash, setSelectedHashRaw] = useState<string | null>(() => {
    try {
      return localStorage.getItem(SELECTED_COMMIT_KEY);
    } catch {
      return null;
    }
  });
  const setSelectedHash = useCallback((hash: string | null) => {
    try {
      if (hash) localStorage.setItem(SELECTED_COMMIT_KEY, hash);
      else localStorage.removeItem(SELECTED_COMMIT_KEY);
    } catch {}
    setSelectedHashRaw(hash);
  }, []);

  // Commit files
  const [commitFiles, setCommitFiles] = useState<CommitFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);

  // File diff
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [diffContent, setDiffContent] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  const gitContextKey = effectiveThreadId || projectModeId;

  // ── Load commits (with pagination) ──

  const loadLog = useCallback(
    async (skip = 0, append = false) => {
      if (!hasGitContext || loadingRef.current) return;
      loadingRef.current = true;
      setLogLoading(true);
      const result = effectiveThreadId
        ? await api.getGitLog(effectiveThreadId, PAGE_SIZE, true, skip)
        : await api.projectGitLog(projectModeId!, PAGE_SIZE, skip);
      if (result.isOk()) {
        const { entries, hasMore: more } = result.value;
        setLogEntries((prev) => (append ? [...prev, ...entries] : entries));
        setHasMore(more);
      } else {
        toast.error(
          t('review.logFailed', {
            message: result.error.message,
            defaultValue: `Failed to load log: ${result.error.message}`,
          }),
        );
      }
      setLogLoading(false);
      loadingRef.current = false;
    },
    [hasGitContext, effectiveThreadId, projectModeId, t],
  );

  const loadMore = useCallback(() => {
    if (!hasMore || loadingRef.current) return;
    loadLog(logEntries.length, true);
  }, [hasMore, logEntries.length, loadLog]);

  // Auto-load on mount / context change
  const prevContextRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const isInitialMount = prevContextRef.current === undefined;
    const contextChanged = prevContextRef.current !== gitContextKey;
    prevContextRef.current = gitContextKey ?? null;

    if (!contextChanged) return;

    loadedRef.current = false;
    setLogEntries([]);
    setHasMore(false);
    setCommitFiles([]);

    // Only clear selected commit when switching between different contexts,
    // not on initial mount (so localStorage-restored value survives)
    if (!isInitialMount) {
      setSelectedHash(null);
    }
  }, [gitContextKey, setSelectedHash]);

  useEffect(() => {
    if (hasGitContext && !loadedRef.current) {
      loadedRef.current = true;
      loadLog(0, false);
    }
  }, [hasGitContext, loadLog]);

  // ── Load commit files when a commit is selected ──

  useEffect(() => {
    if (!selectedHash || !hasGitContext) {
      setCommitFiles([]);
      return;
    }
    let cancelled = false;
    setFilesLoading(true);
    const loadFiles = async () => {
      const result = effectiveThreadId
        ? await api.getCommitFiles(effectiveThreadId, selectedHash)
        : await api.projectCommitFiles(projectModeId!, selectedHash);
      if (cancelled) return;
      if (result.isOk()) {
        setCommitFiles(result.value.files);
      } else {
        toast.error(
          t('review.logFailed', {
            message: result.error.message,
            defaultValue: `Failed to load commit files: ${result.error.message}`,
          }),
        );
        setCommitFiles([]);
      }
      setFilesLoading(false);
    };
    loadFiles();
    return () => {
      cancelled = true;
    };
  }, [selectedHash, hasGitContext, effectiveThreadId, projectModeId, t]);

  // ── Load file diff ──

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

  // ── Convert commit files to FileDiffSummary for FileTree ──
  const treeFiles = useMemo<FileDiffSummary[]>(
    () =>
      commitFiles.map((f) => ({
        path: f.path,
        status: (f.status === 'copied' ? 'renamed' : f.status) as FileStatus,
        staged: false,
        additions: f.additions,
        deletions: f.deletions,
      })),
    [commitFiles],
  );

  // ── Search (filters against all loaded entries) ──
  const [commitSearch, setCommitSearch] = useState('');

  const filteredEntries = useMemo(() => {
    if (!commitSearch.trim()) return logEntries;
    const q = commitSearch.toLowerCase();
    return logEntries.filter(
      (e) =>
        e.message.toLowerCase().includes(q) ||
        e.author.toLowerCase().includes(q) ||
        e.shortHash.toLowerCase().includes(q) ||
        e.hash.toLowerCase().includes(q),
    );
  }, [logEntries, commitSearch]);

  // ── Virtualizer for commit list ──
  const commitScrollRef = useRef<HTMLDivElement>(null);

  // Total row count: filtered entries + 1 sentinel row for "load more" / "loading"
  const showSentinel = hasMore && !commitSearch.trim();
  const rowCount = filteredEntries.length + (showSentinel ? 1 : 0);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => commitScrollRef.current,
    estimateSize: () => COMMIT_ROW_HEIGHT,
    getItemKey: (index) => {
      if (index >= filteredEntries.length) return '__sentinel__';
      return filteredEntries[index].hash;
    },
    overscan: 10,
  });

  // Trigger load-more when the sentinel row becomes visible
  const virtualItems = virtualizer.getVirtualItems();
  const lastItem = virtualItems[virtualItems.length - 1];
  useEffect(() => {
    if (!showSentinel || !lastItem) return;
    // If the last visible virtual item is the sentinel row (or close to it)
    if (lastItem.index >= filteredEntries.length - 5) {
      loadMore();
    }
  }, [lastItem?.index, filteredEntries.length, showSentinel, loadMore]);

  // ── Compute selected commit info ──
  const selectedCommit = logEntries.find((e) => e.hash === selectedHash);

  // ── Commit count label ──
  const commitCountLabel = useMemo(() => {
    if (logEntries.length === 0) return null;
    const total = hasMore ? `${logEntries.length}+` : `${logEntries.length}`;
    if (commitSearch && filteredEntries.length !== logEntries.length) {
      return `${filteredEntries.length}/${total} commits`;
    }
    return `${total} commits`;
  }, [logEntries.length, filteredEntries.length, hasMore, commitSearch]);

  // ── Render ──

  if (!hasGitContext) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-xs text-muted-foreground">
        {t('review.noProject', 'Select a project to view history')}
      </div>
    );
  }

  return (
    <div
      className="flex h-full w-full min-w-0 flex-col overflow-hidden"
      data-testid="commit-history-tab"
    >
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 border-b border-sidebar-border px-2 py-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => {
                loadedRef.current = false;
                loadLog(0, false);
              }}
              className="text-muted-foreground"
              data-testid="history-refresh"
            >
              <RefreshCw className={cn('icon-sm', logLoading && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{t('review.refresh', 'Refresh')}</TooltipContent>
        </Tooltip>
        <span className="ml-1 text-xs text-muted-foreground">{commitCountLabel}</span>
      </div>

      {/* Search */}
      {logEntries.length > 0 && (
        <div className="border-b border-sidebar-border px-2 py-2">
          <div className="relative">
            <Search className="icon-sm pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              placeholder={t('history.searchCommits', 'Filter commits\u2026')}
              aria-label={t('history.searchCommits', 'Filter commits')}
              data-testid="history-commit-search"
              value={commitSearch}
              onChange={(e) => setCommitSearch(e.target.value)}
              className="h-7 pl-7 pr-7 text-xs md:text-xs"
            />
            {commitSearch && (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setCommitSearch('')}
                aria-label={t('review.clearSearch', 'Clear search')}
                data-testid="history-commit-search-clear"
                className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground"
              >
                <X className="icon-xs" />
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Main content: split between commit list and file list */}
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Commit list (virtualized) */}
        <div
          className={cn(
            'overflow-y-auto border-b border-sidebar-border',
            selectedHash ? 'h-[40%] min-h-[120px]' : 'flex-1',
          )}
          ref={commitScrollRef}
        >
          {logLoading && logEntries.length === 0 ? (
            <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
              <Loader2 className="icon-sm animate-spin" />
              {t('review.loadingLog', 'Loading commits\u2026')}
            </div>
          ) : logEntries.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">
              {t('review.noCommits', 'No commits yet')}
            </p>
          ) : filteredEntries.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">
              {t('history.noMatchingCommits', 'No matching commits')}
            </p>
          ) : (
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                // Sentinel row for loading indicator
                if (virtualRow.index >= filteredEntries.length) {
                  return (
                    <div
                      key="__sentinel__"
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: `${virtualRow.size}px`,
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                      className="flex items-center justify-center"
                    >
                      {logLoading ? (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Loader2 className="icon-sm animate-spin" />
                          {t('history.loadingMore', 'Loading more\u2026')}
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={loadMore}
                          className="text-xs text-primary hover:underline"
                          data-testid="history-load-more"
                        >
                          {t('history.loadMore', 'Load more commits')}
                        </button>
                      )}
                    </div>
                  );
                }

                const entry = filteredEntries[virtualRow.index];
                return (
                  <div
                    key={entry.hash}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedHash(selectedHash === entry.hash ? null : entry.hash)
                      }
                      className={cn(
                        'w-full overflow-hidden border-b border-border px-3 py-2 text-left text-xs transition-colors',
                        selectedHash === entry.hash
                          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                          : 'hover:bg-accent/50',
                      )}
                      data-testid={`history-commit-${entry.shortHash}`}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <GitCommit className="icon-xs flex-shrink-0 text-muted-foreground" />
                        <HighlightText
                          text={entry.shortHash}
                          query={commitSearch}
                          className="flex-shrink-0 font-mono text-xs text-primary"
                        />
                        <span className="truncate text-muted-foreground">{entry.relativeDate}</span>
                      </div>
                      <HighlightText
                        text={entry.message}
                        query={commitSearch}
                        className="mt-0.5 block truncate text-foreground"
                      />
                      <HighlightText
                        text={entry.author}
                        query={commitSearch}
                        className="block truncate text-[10px] text-muted-foreground"
                      />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Commit detail: file list */}
        {selectedHash && (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* Commit header */}
            {selectedCommit && (
              <div className="overflow-hidden border-b border-sidebar-border bg-sidebar-accent/30 px-3 py-2">
                <p className="truncate text-xs font-medium text-foreground">
                  {selectedCommit.message}
                </p>
                <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[10px] text-muted-foreground">
                  <code className="flex-shrink-0 font-mono text-primary">
                    {selectedCommit.shortHash}
                  </code>
                  <span className="truncate">{selectedCommit.author}</span>
                  <span className="flex-shrink-0">{selectedCommit.relativeDate}</span>
                </div>
              </div>
            )}

            {/* File list (tree view) */}
            <div className="flex min-h-0 flex-1 flex-col">
              {filesLoading ? (
                <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                  <Loader2 className="icon-sm animate-spin" />
                  {t('review.loading', 'Loading changes\u2026')}
                </div>
              ) : commitFiles.length === 0 ? (
                <p className="p-3 text-xs text-muted-foreground">
                  {t('history.noFiles', 'No files changed')}
                </p>
              ) : (
                <>
                  <div className="flex items-center gap-1.5 border-b border-sidebar-border px-3 py-1.5">
                    <span className="text-xs text-muted-foreground">
                      {t('history.filesChanged', {
                        count: commitFiles.length,
                        defaultValue: `${commitFiles.length} file(s) changed`,
                      })}
                    </span>
                  </div>
                  <ScrollArea className="flex-1">
                    <FileTree
                      files={treeFiles}
                      selectedFile={expandedFile}
                      onFileClick={handleFileClick}
                      testIdPrefix="history-file"
                    />
                  </ScrollArea>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Expanded diff dialog */}
      {expandedFile && (
        <ExpandedDiffDialog
          open={!!expandedFile}
          onOpenChange={(open) => {
            if (!open) {
              setExpandedFile(null);
              setDiffContent(null);
            }
          }}
          filePath={expandedFile}
          oldValue={diffContent ? parseDiffOld(diffContent) : ''}
          newValue={diffContent ? parseDiffNew(diffContent) : ''}
          loading={diffLoading}
          description={
            selectedCommit ? `${selectedCommit.shortHash}: ${getFileName(expandedFile)}` : undefined
          }
        />
      )}
    </div>
  );
}
