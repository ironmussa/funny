import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { FILTER_MAX_SCAN, type GraphEntry, PAGE_SIZE } from '@/components/commit-graph/graph-entry';
import { DEFAULT_GRAPH_BRANCH_SCOPE } from '@/components/commit-graph/HistoryFilters';
import type { GraphFilters } from '@/components/commit-graph/use-graph-filters';
import { useGitHistoryAutoRefresh } from '@/hooks/use-git-history-auto-refresh';
import { api } from '@/lib/api';
import type { GraphBranchScope } from '@/lib/api/git';
import { createClientLogger } from '@/lib/client-logger';
import { mergeLogEntriesByHash, uniqueLogEntriesByHash } from '@/lib/git-log-merge';
import { metric } from '@/lib/telemetry';

const log = createClientLogger('commit-graph');

interface UseCommitGraphLogOptions {
  visible: boolean | undefined;
  hasGitContext: boolean;
  effectiveThreadId: string | undefined;
  projectModeId: string | null;
  /** Project of the thread (or project mode) — part of the context key. */
  contextProjectId: string | null | undefined;
  filters: GraphFilters;
  /** Called when the context changes, to drop state that belongs to the old one. */
  onContextReset: () => void;
}

/**
 * The graph's paged `git log` for the current thread / project and branch
 * scope: loads the first page on reveal and on every context change, pages in
 * more on demand, and keeps paging in the background while a filter is active
 * (up to FILTER_MAX_SCAN commits).
 */
export function useCommitGraphLog({
  visible,
  hasGitContext,
  effectiveThreadId,
  projectModeId,
  contextProjectId,
  filters,
  onContextReset,
}: UseCommitGraphLogOptions) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<GraphEntry[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [logErrorMessage, setLogErrorMessage] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const hasMoreRef = useRef(false);
  const [branchScope, setBranchScope] = useState<GraphBranchScope>(DEFAULT_GRAPH_BRANCH_SCOPE);
  const [unpushed, setUnpushed] = useState<Set<string>>(new Set());
  const [unpulled, setUnpulled] = useState<Set<string>>(new Set());

  const loadingRef = useRef(false);
  const loadedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  // Synchronous mirror of the loaded entries so the background pager can append
  // without a stale closure over React state.
  const entriesRef = useRef<GraphEntry[]>([]);
  const loadedLogSkipRef = useRef(0);

  const gitContextKey = `${effectiveThreadId || projectModeId || ''}::${
    contextProjectId ?? projectModeId ?? ''
  }::${branchScope}`;

  const loadLog = useCallback(
    async (
      skip = 0,
      append = false,
    ): Promise<{ entries: GraphEntry[]; hasMore: boolean } | null> => {
      if (!hasGitContext || loadingRef.current) return null;
      loadingRef.current = true;
      setLogLoading(true);
      if (!append) setLogErrorMessage(null);
      const started = performance.now();
      const signal = abortRef.current?.signal;
      try {
        const result = effectiveThreadId
          ? await api.getGitGraphLog(effectiveThreadId, PAGE_SIZE, branchScope, skip, signal)
          : await api.projectGitGraphLog(projectModeId!, PAGE_SIZE, branchScope, skip, signal);
        if (signal?.aborted) return null;
        let out: { entries: GraphEntry[]; hasMore: boolean } | null = null;
        if (result.isOk()) {
          const {
            entries: next,
            hasMore: more,
            unpushedHashes,
            unpulledHashes = [],
          } = result.value;
          setLogErrorMessage(null);
          loadedLogSkipRef.current = append ? skip + next.length : next.length;
          const merged = append
            ? mergeLogEntriesByHash(entriesRef.current, next)
            : uniqueLogEntriesByHash(next);
          entriesRef.current = merged;
          setEntries(merged);
          hasMoreRef.current = more;
          setHasMore(more);
          setUnpushed((prev) => {
            if (!append) return new Set(unpushedHashes);
            return new Set([...prev, ...unpushedHashes]);
          });
          setUnpulled((prev) => {
            if (!append) return new Set(unpulledHashes);
            return new Set([...prev, ...unpulledHashes]);
          });
          metric('git.graph_log.loaded', performance.now() - started, {
            attributes: { count: String(next.length), append: String(append) },
          });
          out = { entries: merged, hasMore: more };
        } else if (result.error.message !== 'Request aborted') {
          log.warn('graph-log load failed', { error: result.error.message });
          setLogErrorMessage(result.error.message);
          toast.error(
            t('review.logFailed', {
              message: result.error.message,
              defaultValue: `Failed to load log: ${result.error.message}`,
            }),
          );
        }
        return out;
      } finally {
        setLogLoading(false);
        loadingRef.current = false;
      }
    },
    [hasGitContext, effectiveThreadId, projectModeId, branchScope, t],
  );

  const loadMore = useCallback(() => {
    if (!hasMore || loadingRef.current) return;
    loadLog(loadedLogSkipRef.current, true);
  }, [hasMore, loadLog]);

  // Keep the graph in sync with new commits / refs.
  const invalidateHistory = useGitHistoryAutoRefresh({
    effectiveThreadId,
    projectModeId,
    contextKey: gitContextKey,
    visible,
    enabled: hasGitContext,
    busy: logLoading,
    refresh: loadLog,
  });

  const { wantsFilteredHistory, setSearchQuery, resetFilters } = filters;
  const loadFilteredHistory = useCallback(async () => {
    if (!hasMoreRef.current || loadingRef.current) return;
    let nextSkip = loadedLogSkipRef.current;
    while (wantsFilteredHistory() && hasMoreRef.current && nextSkip < FILTER_MAX_SCAN) {
      const result = await loadLog(nextSkip, true);
      if (!result?.hasMore) return;
      const loadedSkip = loadedLogSkipRef.current;
      if (loadedSkip <= nextSkip) return;
      nextSkip = loadedLogSkipRef.current;
    }
  }, [loadLog, wantsFilteredHistory]);

  const updateSearchQuery = useCallback(
    (nextQuery: string) => {
      setSearchQuery(nextQuery);
      if (nextQuery.trim().length > 0) {
        void loadFilteredHistory();
      }
    },
    [loadFilteredHistory, setSearchQuery],
  );

  // Resume filtering after initial loads, refreshes, and pages already in flight.
  useEffect(() => {
    if (visible && !logLoading && !logErrorMessage) void loadFilteredHistory();
  }, [
    visible,
    logLoading,
    logErrorMessage,
    filters.searchQuery,
    filters.syncFilter,
    filters.authors,
    filters.authorOptionsOpen,
    loadFilteredHistory,
  ]);

  const refreshLog = useCallback(() => {
    loadedRef.current = true;
    loadLog(0, false);
  }, [loadLog]);

  // (Re)load whenever the context (thread/project or all-branches toggle) changes.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    loadingRef.current = false;
    loadedRef.current = false;
    entriesRef.current = [];
    loadedLogSkipRef.current = 0;
    setEntries([]);
    hasMoreRef.current = false;
    setHasMore(false);
    setLogErrorMessage(null);
    setUnpushed(new Set());
    setUnpulled(new Set());
    onContextReset();
    // Drop the filter query — it belongs to the old context.
    resetFilters();
    if (visible && hasGitContext) {
      loadedRef.current = true;
      loadLog(0, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps, react-doctor/exhaustive-deps -- intentionally only on context change
  }, [gitContextKey]);

  // Load on first reveal if the tab mounted while hidden.
  useEffect(() => {
    if (visible && hasGitContext && !loadedRef.current) {
      loadedRef.current = true;
      // eslint-disable-next-line react-doctor/no-adjust-state-on-prop-change -- first reveal intentionally triggers the initial graph fetch once.
      loadLog(0, false);
    }
  }, [visible, hasGitContext, loadLog]);

  return {
    entries,
    logLoading,
    logErrorMessage,
    hasMore,
    branchScope,
    setBranchScope,
    unpushed,
    unpulled,
    gitContextKey,
    loadMore,
    refreshLog,
    invalidateHistory,
    updateSearchQuery,
  };
}
