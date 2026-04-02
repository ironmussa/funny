import type { FileDiffSummary, FileStatus } from '@funny/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowUp,
  CloudDownload,
  Download,
  GitCommit,
  GitMerge,
  GitPullRequest,
  Loader2,
  RefreshCw,
  Search,
  Upload,
  X,
} from 'lucide-react';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { HighlightText } from '@/components/ui/highlight-text';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { parseDiffOld, parseDiffNew } from '@/lib/diff-parse';
import { shortRelativeDate } from '@/lib/thread-utils';
import { toastError } from '@/lib/toast-error';
import { cn, resolveThreadBranch } from '@/lib/utils';
import { useGitStatusForThread, useGitStatusStore } from '@/stores/git-status-store';
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
const SELECTED_COMMIT_KEY = 'history_selected_commit';

// ── Helpers ──

function getFileName(filePath: string): string {
  return filePath.split('/').pop() || filePath;
}

// ── Component ──

interface CommitHistoryTabProps {
  visible?: boolean;
}

export function CommitHistoryTab({ visible }: CommitHistoryTabProps) {
  const { t } = useTranslation();
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  // Use selectedThreadId for git requests — it updates immediately on click,
  // before the thread data finishes loading from the API.
  const effectiveThreadId = useThreadStore((s) => s.selectedThreadId) || undefined;
  const projectModeId = !effectiveThreadId ? selectedProjectId : null;
  const hasGitContext = !!(effectiveThreadId || projectModeId);

  // Branch info for PR creation
  const baseBranch = useThreadStore((s) => s.activeThread?.baseBranch);
  const threadBranch = useThreadStore((s) =>
    s.activeThread ? resolveThreadBranch(s.activeThread) : undefined,
  );
  const isAgentRunning = useThreadStore((s) => s.activeThread?.status === 'running');
  const threadGitStatus = useGitStatusForThread(effectiveThreadId);
  const projectGitStatus = useGitStatusStore((s) =>
    projectModeId ? s.statusByProject[projectModeId] : undefined,
  );
  const gitStatus = threadGitStatus ?? projectGitStatus;
  const isOnDifferentBranch =
    !!effectiveThreadId && !!baseBranch && !!threadBranch && threadBranch !== baseBranch;

  // Log entries (accumulated across pages)
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [unpushedHashes, setUnpushedHashes] = useState<Set<string>>(new Set());
  const loadedRef = useRef(false);
  const loadingRef = useRef(false);

  // Git operation states
  const [pullInProgress, setPullInProgress] = useState(false);
  const [fetchInProgress, setFetchInProgress] = useState(false);
  const [pushInProgress, setPushInProgress] = useState(false);
  const [prInProgress, setPrInProgress] = useState(false);
  const [prDialog, setPrDialog] = useState<{ title: string; body: string } | null>(null);

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

  // Commit body (full description)
  const [commitBody, setCommitBody] = useState<string | null>(null);

  // File search
  const [fileSearch, setFileSearch] = useState('');

  // File diff
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [diffContent, setDiffContent] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  const gitContextKey = effectiveThreadId || projectModeId;

  // AbortController for in-flight git log requests — aborted on context change
  const abortRef = useRef<AbortController | null>(null);

  // ── Load commits (with pagination) ──

  const loadLog = useCallback(
    async (skip = 0, append = false) => {
      if (!hasGitContext || loadingRef.current) return;
      loadingRef.current = true;
      setLogLoading(true);
      const signal = abortRef.current?.signal;
      const result = effectiveThreadId
        ? await api.getGitLog(effectiveThreadId, PAGE_SIZE, true, skip, signal)
        : await api.projectGitLog(projectModeId!, PAGE_SIZE, skip, signal);
      if (result.isOk()) {
        const { entries, hasMore: more, unpushedHashes: hashes } = result.value;
        setLogEntries((prev) => (append ? [...prev, ...entries] : entries));
        setHasMore(more);
        if (hashes) {
          setUnpushedHashes((prev) => {
            if (!append) return new Set(hashes);
            const next = new Set(prev);
            for (const h of hashes) next.add(h);
            return next;
          });
        } else if (!append) {
          setUnpushedHashes(new Set());
        }
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

    // Abort in-flight git log requests from the previous context
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    loadedRef.current = false;
    setLogEntries([]);
    setHasMore(false);
    setUnpushedHashes(new Set());
    setCommitFiles([]);

    // Only clear selected commit when switching between different contexts,
    // not on initial mount (so localStorage-restored value survives)
    if (!isInitialMount) {
      setSelectedHash(null);
    }
  }, [gitContextKey, setSelectedHash]);

  useEffect(() => {
    if (visible && hasGitContext && !loadedRef.current) {
      loadedRef.current = true;
      loadLog(0, false);
    }
  }, [visible, hasGitContext, loadLog]);

  // Refresh when tab becomes visible (e.g. after committing in Changes tab)
  const prevVisibleRef = useRef(visible);
  useEffect(() => {
    const wasHidden = prevVisibleRef.current === false;
    prevVisibleRef.current = visible;
    if (visible && wasHidden && hasGitContext && loadedRef.current) {
      loadLog(0, false);
    }
  }, [visible, hasGitContext, loadLog]);

  // ── Load commit files when a commit is selected ──

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
    const load = async () => {
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
    };
    load();
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
  const treeFiles = useMemo<FileDiffSummary[]>(() => {
    const all = commitFiles.map((f) => ({
      path: f.path,
      status: (f.status === 'copied' ? 'renamed' : f.status) as FileStatus,
      staged: false,
      additions: f.additions,
      deletions: f.deletions,
    }));
    if (!fileSearch.trim()) return all;
    const q = fileSearch.toLowerCase();
    return all.filter((f) => f.path.toLowerCase().includes(q));
  }, [commitFiles, fileSearch]);

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
    estimateSize: () => 40,
    getItemKey: (index) => {
      if (index >= filteredEntries.length) return '__sentinel__';
      return filteredEntries[index].hash;
    },
    overscan: 10,
    measureElement: (el) => el.getBoundingClientRect().height,
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

  // ── Git operations ──

  const hasUnpushed = unpushedHashes.size > 0;

  const handlePull = useCallback(async () => {
    if (!hasGitContext || pullInProgress) return;
    setPullInProgress(true);
    const result = effectiveThreadId
      ? await api.pull(effectiveThreadId)
      : await api.projectPull(projectModeId!);
    if (result.isErr()) {
      toast.error(
        t('review.pullFailed', {
          message: result.error.message,
          defaultValue: `Pull failed: ${result.error.message}`,
        }),
      );
    } else {
      toast.success(t('review.pullSuccess', 'Pulled successfully'));
    }
    setPullInProgress(false);
    // Refresh git status (unpulledCommitCount, etc.) like ReviewPane does
    if (effectiveThreadId) useGitStatusStore.getState().fetchForThread(effectiveThreadId, true);
    else if (projectModeId) useGitStatusStore.getState().fetchProjectStatus(projectModeId, true);
    loadedRef.current = false;
    loadLog(0, false);
  }, [hasGitContext, pullInProgress, effectiveThreadId, projectModeId, t, loadLog]);

  const handleFetchOrigin = useCallback(async () => {
    if (!hasGitContext || fetchInProgress) return;
    setFetchInProgress(true);
    const result = effectiveThreadId
      ? await api.fetchOrigin(effectiveThreadId)
      : await api.projectFetchOrigin(projectModeId!);
    if (result.isErr()) {
      const msg = result.error.message;
      const isAuthError =
        /auth|token|credential|permission|denied|403|fatal:/i.test(msg) ||
        result.error.type === 'INTERNAL';
      toast.error(
        isAuthError
          ? t('review.fetchAuthFailed', {
              defaultValue:
                'Fetch failed: authentication error. Check your GitHub token in Settings > Profile.',
            })
          : t('review.fetchFailed', {
              message: msg,
              defaultValue: `Fetch failed: ${msg}`,
            }),
      );
    } else {
      toast.success(t('review.fetchSuccess', 'Fetched from origin'));
    }
    setFetchInProgress(false);
    // Refresh git status (unpulledCommitCount, etc.) like ReviewPane does
    if (effectiveThreadId) useGitStatusStore.getState().fetchForThread(effectiveThreadId, true);
    else if (projectModeId) useGitStatusStore.getState().fetchProjectStatus(projectModeId, true);
    loadedRef.current = false;
    loadLog(0, false);
  }, [hasGitContext, fetchInProgress, effectiveThreadId, projectModeId, t, loadLog]);

  const handlePush = useCallback(async () => {
    if (!hasGitContext || pushInProgress) return;
    setPushInProgress(true);
    const result = effectiveThreadId
      ? await api.startWorkflow(effectiveThreadId, { action: 'push' })
      : await api.projectStartWorkflow(projectModeId!, { action: 'push' });
    if (result.isErr()) {
      toast.error(
        t('review.pushFailed', {
          message: result.error.message,
          defaultValue: `Push failed: ${result.error.message}`,
        }),
      );
      setPushInProgress(false);
    } else {
      // Don't toast here — the workflow runs async. Success/failure
      // will be reported via git:workflow_progress WebSocket events.
      setPushInProgress(false);
      loadedRef.current = false;
      loadLog(0, false);
    }
  }, [hasGitContext, pushInProgress, effectiveThreadId, projectModeId, t, loadLog]);

  const handleCreatePR = useCallback(async () => {
    if (!hasGitContext || prInProgress || !prDialog) return;
    setPrInProgress(true);

    const result = effectiveThreadId
      ? await api.startWorkflow(effectiveThreadId, {
          action: 'create-pr',
          prTitle: prDialog.title.trim(),
          prBody: prDialog.body.trim(),
        })
      : await api.projectStartWorkflow(projectModeId!, {
          action: 'create-pr',
          prTitle: prDialog.title.trim(),
          prBody: prDialog.body.trim(),
        });

    if (result.isErr()) {
      toastError(result.error);
      setPrInProgress(false);
      return;
    }
    setPrDialog(null);
    setPrInProgress(false);
  }, [hasGitContext, prInProgress, prDialog, effectiveThreadId, projectModeId]);

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
      <div className="flex items-center gap-1 border-b border-sidebar-border px-2 py-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                loadedRef.current = false;
                loadLog(0, false);
              }}
              className="text-muted-foreground"
              data-testid="history-refresh"
            >
              <RefreshCw className={cn('icon-base', logLoading && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{t('review.refresh', 'Refresh')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handlePull}
              disabled={pullInProgress}
              className="relative text-muted-foreground"
              data-testid="history-pull"
            >
              <Download className={cn('icon-base', pullInProgress && 'animate-pulse')} />
              {(gitStatus?.unpulledCommitCount ?? 0) > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-blue-500 px-0.5 text-[9px] font-bold leading-none text-white">
                  {gitStatus!.unpulledCommitCount}
                </span>
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {(gitStatus?.unpulledCommitCount ?? 0) > 0
              ? t('review.readyToPull', {
                  count: gitStatus!.unpulledCommitCount,
                  defaultValue: `${gitStatus!.unpulledCommitCount} commit(s) to pull`,
                })
              : t('review.pull', 'Pull')}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleFetchOrigin}
              disabled={fetchInProgress}
              className="text-muted-foreground"
              data-testid="history-fetch-origin"
            >
              <CloudDownload className={cn('icon-base', fetchInProgress && 'animate-pulse')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{t('review.fetchOrigin', 'Fetch from origin')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handlePush}
              disabled={pushInProgress || !hasUnpushed}
              className="text-muted-foreground"
              data-testid="history-push"
            >
              <Upload className={cn('icon-base', pushInProgress && 'animate-pulse')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {hasUnpushed
              ? t('review.readyToPush', {
                  count: unpushedHashes.size,
                  defaultValue: `${unpushedHashes.size} commit(s) ready to push`,
                })
              : t('review.pushToOrigin', 'Push to origin')}
          </TooltipContent>
        </Tooltip>
        {hasUnpushed && (
          <span
            className="ml-1 flex items-center gap-0.5 text-xs text-amber-500"
            data-testid="history-unpushed-count"
          >
            {unpushedHashes.size}
            <ArrowUp className="icon-xs" />
          </span>
        )}
        {isOnDifferentBranch && (
          <Tooltip>
            <TooltipTrigger asChild>
              {gitStatus?.prNumber ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => window.open(gitStatus.prUrl, '_blank')}
                  className="ml-auto text-muted-foreground"
                  data-testid="history-view-pr"
                >
                  {gitStatus.prState === 'MERGED' ? (
                    <GitMerge className="icon-base text-purple-500" />
                  ) : (
                    <GitPullRequest className="icon-base text-green-500" />
                  )}
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setPrDialog({ title: threadBranch || '', body: '' })}
                  disabled={!!isAgentRunning}
                  className="ml-auto text-muted-foreground"
                  data-testid="history-create-pr"
                >
                  <GitPullRequest className="icon-base" />
                </Button>
              )}
            </TooltipTrigger>
            <TooltipContent side="top">
              {gitStatus?.prNumber
                ? t('review.viewPR', {
                    number: gitStatus.prNumber,
                    defaultValue: `View PR #${gitStatus.prNumber}`,
                  })
                : t('review.createPRTooltip', {
                    branch: threadBranch,
                    target: baseBranch || 'base',
                  })}
            </TooltipContent>
          </Tooltip>
        )}
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
                      ref={virtualizer.measureElement}
                      data-index={virtualRow.index}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                      className="flex items-center justify-center py-2"
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
                    ref={virtualizer.measureElement}
                    data-index={virtualRow.index}
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
                      <HighlightText
                        text={entry.message}
                        query={commitSearch}
                        className="block truncate font-medium text-foreground"
                      />
                      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
                        <GitCommit className="icon-xs flex-shrink-0" />
                        <HighlightText
                          text={entry.shortHash}
                          query={commitSearch}
                          className="flex-shrink-0 font-mono text-primary"
                        />
                        {unpushedHashes.has(entry.hash) && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <ArrowUp
                                className="icon-xs flex-shrink-0 text-amber-500"
                                data-testid={`history-unpushed-${entry.shortHash}`}
                              />
                            </TooltipTrigger>
                            <TooltipContent side="top">
                              {t('history.unpushed', 'Not pushed')}
                            </TooltipContent>
                          </Tooltip>
                        )}
                        <span className="min-w-0 truncate">
                          <HighlightText text={entry.author} query={commitSearch} />
                        </span>
                        <span className="flex-shrink-0 text-muted-foreground">
                          {shortRelativeDate(entry.relativeDate)}
                        </span>
                      </div>
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
              <div className="max-h-[140px] overflow-y-auto border-b border-sidebar-border bg-sidebar-accent/30 px-3 py-2">
                <p className="text-xs font-medium text-foreground">{selectedCommit.message}</p>
                {commitBody && (
                  <p className="mt-1 whitespace-pre-wrap text-[11px] text-muted-foreground">
                    {commitBody}
                  </p>
                )}
                <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
                  <GitCommit className="icon-xs flex-shrink-0" />
                  <code className="flex-shrink-0 font-mono text-primary">
                    {selectedCommit.shortHash}
                  </code>
                  <span className="min-w-0 truncate">{selectedCommit.author}</span>
                  <span className="flex-shrink-0 text-muted-foreground">
                    {shortRelativeDate(selectedCommit.relativeDate)}
                  </span>
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
                  {/* File search */}
                  <div className="border-b border-sidebar-border px-2 py-2">
                    <div className="relative">
                      <Search className="icon-sm pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        type="text"
                        placeholder={t('review.searchFiles', 'Filter files\u2026')}
                        aria-label={t('review.searchFiles', 'Filter files')}
                        data-testid="history-file-search"
                        value={fileSearch}
                        onChange={(e) => setFileSearch(e.target.value)}
                        className="h-7 pl-7 pr-7 text-xs md:text-xs"
                      />
                      {fileSearch && (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => setFileSearch('')}
                          aria-label={t('review.clearSearch', 'Clear search')}
                          data-testid="history-file-search-clear"
                          className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground"
                        >
                          <X className="icon-xs" />
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* File count */}
                  <div className="flex items-center gap-1.5 border-b border-sidebar-border px-3 py-1.5">
                    <span className="text-xs text-muted-foreground">
                      {fileSearch.trim() && treeFiles.length !== commitFiles.length
                        ? `${treeFiles.length}/${commitFiles.length}`
                        : `${commitFiles.length}`}{' '}
                      {t('history.files', 'file(s)')}
                    </span>
                  </div>

                  {treeFiles.length === 0 ? (
                    <p className="p-3 text-xs text-muted-foreground">
                      {t('history.noMatchingFiles', 'No matching files')}
                    </p>
                  ) : (
                    <ScrollArea className="flex-1">
                      <FileTree
                        files={treeFiles}
                        selectedFile={expandedFile}
                        onFileClick={handleFileClick}
                        testIdPrefix="history-file"
                        searchQuery={fileSearch || undefined}
                      />
                    </ScrollArea>
                  )}
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

      {/* Create PR dialog */}
      <Dialog
        open={!!prDialog}
        onOpenChange={(open) => {
          if (!open) setPrDialog(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('review.createPR')}</DialogTitle>
            <DialogDescription>
              {t('review.createPRTooltip', { branch: threadBranch, target: baseBranch || 'base' })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <input
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder={t('review.prTitle', 'PR title')}
              data-testid="history-pr-title"
              value={prDialog?.title ?? ''}
              onChange={(e) =>
                setPrDialog((prev) => (prev ? { ...prev, title: e.target.value } : prev))
              }
            />
            <textarea
              className="w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              rows={4}
              placeholder={t('review.commitBody', 'Description (optional)')}
              data-testid="history-pr-body"
              value={prDialog?.body ?? ''}
              onChange={(e) =>
                setPrDialog((prev) => (prev ? { ...prev, body: e.target.value } : prev))
              }
            />
          </div>
          <div className="mt-2 flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPrDialog(null)}
              data-testid="history-pr-cancel"
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              size="sm"
              disabled={!prDialog?.title.trim() || prInProgress}
              onClick={handleCreatePR}
              data-testid="history-pr-create"
            >
              {prInProgress ? (
                <Loader2 className="icon-sm mr-1.5 animate-spin" />
              ) : (
                <GitPullRequest className="icon-sm mr-1.5" />
              )}
              {t('review.createPR')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
