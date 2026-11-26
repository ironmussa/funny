import type { TFunction } from 'i18next';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import { useTranslation } from 'react-i18next';

import { FILTER_MAX_SCAN, type GraphEntry, PAGE_SIZE } from '@/components/commit-graph/graph-entry';
import { DEFAULT_GRAPH_BRANCH_SCOPE } from '@/components/commit-graph/HistoryFilters';
import type { GraphFilters } from '@/components/commit-graph/use-graph-filters';
import { toast } from '@/components/ui/toast';
import { useGitHistoryAutoRefresh } from '@/hooks/use-git-history-auto-refresh';
import { useStableCallback } from '@/hooks/use-stable-callback';
import { api } from '@/lib/api';
import type { GraphBranchScope } from '@/lib/api/git';
import { createClientLogger } from '@/lib/client-logger';
import { mergeLogEntriesByHash, uniqueLogEntriesByHash } from '@/lib/git-log-merge';
import { metric } from '@/lib/telemetry';
import { withCleanup } from '@/lib/while-pending';

const log = createClientLogger('commit-graph');

type GraphLogPage = { entries: GraphEntry[]; hasMore: boolean };
interface GraphLogResponse {
  entries: GraphEntry[];
  hasMore: boolean;
  unpushedHashes: string[];
  unpulledHashes?: string[];
}

/** The refs and setters a loaded page is written into. */
interface GraphLogPageSink {
  entriesRef: RefObject<GraphEntry[]>;
  loadedLogSkipRef: RefObject<number>;
  hasMoreRef: RefObject<boolean>;
  setEntries: Dispatch<SetStateAction<GraphEntry[]>>;
  setHasMore: Dispatch<SetStateAction<boolean>>;
  setUnpushed: Dispatch<SetStateAction<Set<string>>>;
  setUnpulled: Dispatch<SetStateAction<Set<string>>>;
  setLogErrorMessage: Dispatch<SetStateAction<string | null>>;
}

/** One page of the thread's graph log, or the project's when there is no thread. */
function fetchGraphLogPage(
  effectiveThreadId: string | undefined,
  projectModeId: string | null,
  branchScope: GraphBranchScope,
  skip: number,
  signal: AbortSignal | undefined,
) {
  return effectiveThreadId
    ? api.getGitGraphLog(effectiveThreadId, PAGE_SIZE, branchScope, skip, signal)
    : api.projectGitGraphLog(projectModeId!, PAGE_SIZE, branchScope, skip, signal);
}

/** Write a loaded page into the hook's state: replace on a first page, merge when appending. */
function applyGraphLogPage(
  sink: GraphLogPageSink,
  page: GraphLogResponse,
  skip: number,
  append: boolean,
): GraphLogPage {
  const { entries: next, hasMore: more, unpushedHashes, unpulledHashes = [] } = page;
  sink.setLogErrorMessage(null);
  sink.loadedLogSkipRef.current = append ? skip + next.length : next.length;
  const merged = append
    ? mergeLogEntriesByHash(sink.entriesRef.current, next)
    : uniqueLogEntriesByHash(next);
  sink.entriesRef.current = merged;
  sink.setEntries(merged);
  sink.hasMoreRef.current = more;
  sink.setHasMore(more);
  sink.setUnpushed((prev) => mergeHashes(prev, unpushedHashes, append));
  sink.setUnpulled((prev) => mergeHashes(prev, unpulledHashes, append));
  return { entries: merged, hasMore: more };
}

function mergeHashes(prev: Set<string>, hashes: string[], append: boolean): Set<string> {
  return append ? new Set([...prev, ...hashes]) : new Set(hashes);
}

/** Show a failed load (an aborted request is not a failure). */
function reportGraphLogFailure(
  message: string,
  t: TFunction,
  setLogErrorMessage: (message: string) => void,
) {
  if (message === 'Request aborted') return;
  log.warn('graph-log load failed', { error: message });
  setLogErrorMessage(message);
  toast.error(
    t('review.logFailed', {
      message,
      defaultValue: `Failed to load log: ${message}`,
    }),
  );
}

/**
 * Keep paging while a filter wants more history, until the log ends, a page
 * adds nothing, or FILTER_MAX_SCAN commits are loaded.
 */
async function pageWhileFiltering(
  loadLog: (skip: number, append: boolean) => Promise<GraphLogPage | null>,
  wantsFilteredHistory: () => boolean,
  hasMoreRef: RefObject<boolean>,
  loadedLogSkipRef: RefObject<number>,
) {
  let nextSkip = loadedLogSkipRef.current;
  while (wantsFilteredHistory() && hasMoreRef.current && nextSkip < FILTER_MAX_SCAN) {
    const result = await loadLog(nextSkip, true);
    if (!result?.hasMore) return;
    if (loadedLogSkipRef.current <= nextSkip) return;
    nextSkip = loadedLogSkipRef.current;
  }
}

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

/** The log's state, the refs the loaders read synchronously, and the sink a loaded page is written into. */
function useGraphLogState() {
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
  // Refs and state setters are stable, so the sink is built once.
  const pageSink = useMemo<GraphLogPageSink>(
    () => ({
      entriesRef,
      loadedLogSkipRef,
      hasMoreRef,
      setEntries,
      setHasMore,
      setUnpushed,
      setUnpulled,
      setLogErrorMessage,
    }),
    [],
  );

  return {
    entries,
    setEntries,
    logLoading,
    setLogLoading,
    logErrorMessage,
    setLogErrorMessage,
    hasMore,
    setHasMore,
    hasMoreRef,
    branchScope,
    setBranchScope,
    unpushed,
    setUnpushed,
    unpulled,
    setUnpulled,
    loadingRef,
    loadedRef,
    abortRef,
    entriesRef,
    loadedLogSkipRef,
    pageSink,
  };
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
  const {
    entries,
    setEntries,
    logLoading,
    setLogLoading,
    logErrorMessage,
    setLogErrorMessage,
    hasMore,
    setHasMore,
    hasMoreRef,
    branchScope,
    setBranchScope,
    unpushed,
    setUnpushed,
    unpulled,
    setUnpulled,
    loadingRef,
    loadedRef,
    abortRef,
    entriesRef,
    loadedLogSkipRef,
    pageSink,
  } = useGraphLogState();

  const gitContextKey = `${effectiveThreadId || projectModeId || ''}::${
    contextProjectId ?? projectModeId ?? ''
  }::${branchScope}`;

  const loadLog = useCallback(
    async (skip = 0, append = false): Promise<GraphLogPage | null> => {
      if (!hasGitContext || loadingRef.current) return null;
      loadingRef.current = true;
      setLogLoading(true);
      if (!append) setLogErrorMessage(null);
      const started = performance.now();
      const signal = abortRef.current?.signal;
      return withCleanup(
        async () => {
          const result = await fetchGraphLogPage(
            effectiveThreadId,
            projectModeId,
            branchScope,
            skip,
            signal,
          );
          if (signal?.aborted) return null;
          if (result.isErr()) {
            reportGraphLogFailure(result.error.message, t, setLogErrorMessage);
            return null;
          }
          const out = applyGraphLogPage(pageSink, result.value, skip, append);
          metric('git.graph_log.loaded', performance.now() - started, {
            attributes: { count: String(result.value.entries.length), append: String(append) },
          });
          return out;
        },
        () => {
          setLogLoading(false);
          loadingRef.current = false;
        },
      );
    },
    [
      hasGitContext,
      effectiveThreadId,
      projectModeId,
      branchScope,
      t,
      pageSink,
      loadingRef,
      abortRef,
      setLogLoading,
      setLogErrorMessage,
    ],
  );

  const loadMore = useCallback(() => {
    if (!hasMore || loadingRef.current) return;
    loadLog(loadedLogSkipRef.current, true);
  }, [hasMore, loadLog, loadingRef, loadedLogSkipRef]);

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
    await pageWhileFiltering(loadLog, wantsFilteredHistory, hasMoreRef, loadedLogSkipRef);
  }, [loadLog, wantsFilteredHistory, loadingRef, hasMoreRef, loadedLogSkipRef]);

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
  }, [loadLog, loadedRef]);

  // (Re)load whenever the context (thread/project or all-branches toggle) changes.
  const resetOnContextChange = useStableCallback(() => {
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
  });
  useEffect(() => {
    resetOnContextChange();
  }, [gitContextKey, resetOnContextChange]);

  // Load on first reveal if the tab mounted while hidden.
  useEffect(() => {
    if (visible && hasGitContext && !loadedRef.current) {
      loadedRef.current = true;
      // eslint-disable-next-line react-doctor/no-adjust-state-on-prop-change -- first reveal intentionally triggers the initial graph fetch once.
      loadLog(0, false);
    }
  }, [visible, hasGitContext, loadLog, loadedRef]);

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
