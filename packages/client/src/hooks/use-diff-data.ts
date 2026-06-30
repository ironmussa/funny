import type { FileDiffSummary } from '@funny/shared';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';

import { useAutoRefreshDiff } from '@/hooks/use-auto-refresh-diff';
import { gitApi } from '@/lib/api/git';
import { parseDiffOld, parseDiffNew } from '@/lib/diff-parse';
import { useGitStatusStore } from '@/stores/git-status-store';

interface UseDiffDataArgs {
  hasGitContext: boolean;
  effectiveThreadId: string | undefined;
  projectModeId: string | null;
  selectedFile: string | null;
  expandedFile: string | null;
  reviewPaneOpen: boolean;
  /** ReviewPane owns this state (consumed by many places); we read + write it. */
  summaries: FileDiffSummary[];
  setSummaries: Dispatch<SetStateAction<FileDiffSummary[]>>;
  /** Inner files of expanded submodules — used to resolve composite paths. */
  submoduleExpansions: Map<string, FileDiffSummary[]>;
  /** Refresh sets this to the first file when nothing is selected yet. */
  setSelectedFile: (path: string | null) => void;
  /** Refresh adds new files to the selection (keeps existing). */
  setCheckedFiles: Dispatch<SetStateAction<Set<string>>>;
  /** Git-status dirty count for the same context; used to recover missed refreshes. */
  dirtyFileCount?: number;
  linesAdded?: number;
  linesDeleted?: number;
}

export interface UseDiffDataResult {
  // State (owned here since these are only used through this hook's surface)
  diffCache: Map<string, string>;
  loadingDiff: string | null;
  loading: boolean;
  loadError: boolean;
  loadErrorMessage: string | null;
  truncatedInfo: { total: number; truncated: boolean };

  // Setters (used by the parent's gitContextKey reset effect)
  setDiffCache: Dispatch<SetStateAction<Map<string, string>>>;
  setLoadError: Dispatch<SetStateAction<boolean>>;
  setLoadErrorMessage: Dispatch<SetStateAction<string | null>>;

  // Refs (passed into peer hooks like useStashState that share request lifecycle)
  abortRef: React.MutableRefObject<AbortController | null>;
  needsRefreshRef: React.MutableRefObject<boolean>;

  // Operations
  refresh: () => Promise<void>;
  loadDiffForFile: (filePath: string) => Promise<void>;
  requestFullDiff: (
    path: string,
  ) => Promise<{ oldValue: string; newValue: string; rawDiff?: string } | null>;
}

/**
 * Owns the diff-summary + per-file diff loading lifecycle for ReviewPane.
 * Three operations: `refresh` (full summary + auto-load selected file),
 * `loadDiffForFile` (lazy single-file load on selection), and `requestFullDiff`
 * (full-context fetch for the "show full file" toggle inside ExpandedDiffView).
 *
 * Coordinates aborts through `abortRef` (also consumed by useStashState) and
 * uses an epoch counter so a stale awaited refresh can't overwrite fresh state
 * after a thread switch.
 *
 * Final piece of the ReviewPane god-file split — see
 * .claude/plans/reviewpane-split.md.
 */
export function useDiffData({
  hasGitContext,
  effectiveThreadId,
  projectModeId,
  selectedFile,
  expandedFile,
  reviewPaneOpen,
  summaries,
  setSummaries,
  submoduleExpansions,
  setSelectedFile,
  setCheckedFiles,
  dirtyFileCount,
  linesAdded,
  linesDeleted,
}: UseDiffDataArgs): UseDiffDataResult {
  // Reconstruct the submodule resolver locally. Identical to the one in
  // useFileTreeState, duplicated to avoid a circular dependency: useFileTreeState
  // needs `summaries` (from this hook) while this hook needs the resolver to
  // route diff requests for inner files of expanded submodules.
  const resolveSubmoduleEntry = useCallback(
    (filePath: string): { submodulePath: string; innerPath: string; staged: boolean } | null => {
      for (const [submodulePath, inner] of submoduleExpansions) {
        const prefix = `${submodulePath}/`;
        if (!filePath.startsWith(prefix)) continue;
        const innerPath = filePath.slice(prefix.length);
        const innerSummary = inner.find((f) => f.path === innerPath);
        if (!innerSummary) continue;
        return { submodulePath, innerPath, staged: innerSummary.staged };
      }
      return null;
    },
    [submoduleExpansions],
  );

  const [diffCache, setDiffCache] = useState<Map<string, string>>(new Map());
  const [loadingDiff, setLoadingDiff] = useState<string | null>(null);
  const [truncatedInfo, setTruncatedInfo] = useState<{ total: number; truncated: boolean }>({
    total: 0,
    truncated: false,
  });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loadErrorMessage, setLoadErrorMessage] = useState<string | null>(null);

  // AbortController for in-flight git requests. Aborted when the git context
  // changes (thread/project switch) to prevent piling up stale requests that
  // saturate the server's git process pool and cause progressive slowdown.
  const abortRef = useRef<AbortController | null>(null);

  // Monotonically increasing counter to detect stale refresh results. When a
  // new refresh starts, it captures the current value; if another refresh
  // starts before it finishes, the older one detects the mismatch and bails
  // out instead of overwriting state with stale data.
  const refreshEpochRef = useRef(0);

  // True while refresh() is running — used to suppress the selectedFile
  // effect from firing a duplicate diff/file load (refresh already loads it).
  const refreshingRef = useRef(false);

  // Track whether we need to refresh when the pane becomes visible.
  const needsRefreshRef = useRef(false);

  // Tracks the (context + git-status snapshot) that already triggered an
  // ensure-loaded refresh. Keying on the status snapshot lets a later dirty
  // update re-fire once (recovery) while preventing loops when the server
  // truly returns no files for that snapshot.
  const ensureLoadedKeyRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!hasGitContext) return;
    refreshingRef.current = true;
    const epoch = ++refreshEpochRef.current;

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const { signal } = ac;

    setLoading(true);
    setLoadError(false);
    setLoadErrorMessage(null);

    // Fire git status refresh in parallel (don't await — it updates its own store).
    if (effectiveThreadId) useGitStatusStore.getState().fetchForThread(effectiveThreadId);
    else if (projectModeId) useGitStatusStore.getState().fetchProjectStatus(projectModeId);

    try {
      const result = effectiveThreadId
        ? await gitApi.getDiffSummary(effectiveThreadId, undefined, undefined, signal)
        : await gitApi.projectDiffSummary(projectModeId!, undefined, undefined, signal);

      // Superseded by a newer refresh, or this request was aborted (context
      // reset / thread switch): don't write state. The `finally` below still
      // clears `loading` when this is the live epoch, so the panel can't get
      // stuck on the spinner.
      if (refreshEpochRef.current !== epoch || signal.aborted) return;

      if (result.isOk()) {
        const data = result.value;

        // Determine which visible files to reload before state updates so we can
        // fire their diff requests in parallel with React batching.
        const refreshedPaths = new Set(data.files.map((d) => d.path));
        const selectedStillExists = selectedFile ? refreshedPaths.has(selectedFile) : false;
        const fileToLoad = selectedStillExists
          ? selectedFile
          : data.files.length > 0
            ? data.files[0].path
            : null;
        const fileToLoadSummary = fileToLoad
          ? data.files.find((s) => s.path === fileToLoad)
          : undefined;
        const expandedFileToLoad =
          expandedFile && expandedFile !== fileToLoad && refreshedPaths.has(expandedFile)
            ? expandedFile
            : null;
        const expandedFileSummary = expandedFileToLoad
          ? data.files.find((s) => s.path === expandedFileToLoad)
          : undefined;

        const fetchFreshDiff = async (filePath: string, staged: boolean) => {
          setLoadingDiff(filePath);
          const diffResult = effectiveThreadId
            ? await gitApi.getFileDiff(effectiveThreadId, filePath, staged, signal)
            : await gitApi.projectFileDiff(projectModeId!, filePath, staged, signal);
          if (refreshEpochRef.current === epoch && diffResult.isOk() && !signal.aborted) {
            setDiffCache((prev) => new Map(prev).set(filePath, diffResult.value.diff));
          }
          setLoadingDiff((prev) => (prev === filePath ? null : prev));
        };

        setSummaries(data.files);
        setTruncatedInfo({ total: data.total, truncated: data.truncated });
        // A refresh means git state may have changed even if the same file paths
        // are still present. Clear stale per-path diffs before any fresh visible
        // diff responses can populate the cache again.
        setDiffCache(new Map());

        // Start visible diff fetches after publishing the summary, so the file
        // list does not depend on single-file diff timing.
        const diffPromises: Promise<void>[] = [];
        if (fileToLoad && fileToLoadSummary && !signal.aborted) {
          diffPromises.push(fetchFreshDiff(fileToLoad, fileToLoadSummary.staged));
        }
        if (expandedFileToLoad && expandedFileSummary && !signal.aborted) {
          diffPromises.push(fetchFreshDiff(expandedFileToLoad, expandedFileSummary.staged));
        }

        setCheckedFiles((prev) => {
          const next = new Set(prev);
          const currentPaths = new Set(data.files.map((d) => d.path));
          for (const f of data.files) {
            if (!prev.has(f.path) && prev.size === 0) {
              next.add(f.path);
            } else if (!prev.has(f.path) && data.files.length > prev.size) {
              next.add(f.path);
            }
          }
          for (const p of prev) {
            if (!currentPaths.has(p)) next.delete(p);
          }
          return next.size === 0 ? new Set(data.files.map((d) => d.path)) : next;
        });
        if (fileToLoad !== selectedFile) {
          setSelectedFile(fileToLoad);
        }

        if (diffPromises.length > 0) await Promise.all(diffPromises);
      } else {
        console.error('Failed to load diff summary:', result.error);
        setLoadError(true);
        setLoadErrorMessage(result.error.message);
      }
    } finally {
      // Only the live refresh owns `loading`. A superseded refresh leaves the
      // flag to its successor; the live one always clears it — even if its
      // fetch was aborted — so the Changes tab never gets stuck on the spinner.
      if (refreshEpochRef.current === epoch) {
        setLoading(false);
        refreshingRef.current = false;
      }
    }
  }, [
    hasGitContext,
    effectiveThreadId,
    projectModeId,
    selectedFile,
    expandedFile,
    setSelectedFile,
    setSummaries,
    setCheckedFiles,
  ]);

  // Lazy load diff content for a specific file.
  const loadDiffForFile = useCallback(
    async (filePath: string) => {
      if (!hasGitContext || diffCache.has(filePath)) return;
      const submoduleEntry = resolveSubmoduleEntry(filePath);
      const summary = submoduleEntry ? null : summaries.find((s) => s.path === filePath);
      if (!submoduleEntry && !summary) return;
      const signal = abortRef.current?.signal;
      setLoadingDiff(filePath);
      const result = submoduleEntry
        ? effectiveThreadId
          ? await gitApi.getSubmoduleFileDiff(
              effectiveThreadId,
              submoduleEntry.submodulePath,
              submoduleEntry.innerPath,
              submoduleEntry.staged,
              signal,
            )
          : await gitApi.projectSubmoduleFileDiff(
              projectModeId!,
              submoduleEntry.submodulePath,
              submoduleEntry.innerPath,
              submoduleEntry.staged,
              signal,
            )
        : effectiveThreadId
          ? await gitApi.getFileDiff(effectiveThreadId, filePath, summary!.staged, signal)
          : await gitApi.projectFileDiff(projectModeId!, filePath, summary!.staged, signal);
      if (result.isOk() && !signal?.aborted) {
        setDiffCache((prev) => new Map(prev).set(filePath, result.value.diff));
      }
      setLoadingDiff((prev) => (prev === filePath ? null : prev));
    },
    [hasGitContext, diffCache, summaries, effectiveThreadId, projectModeId, resolveSubmoduleEntry],
  );

  // Fetch full-context diff for the "Show full file" toggle.
  const requestFullDiff = useCallback(
    async (path: string) => {
      if (!hasGitContext) return null;
      const submoduleEntry = resolveSubmoduleEntry(path);
      const summary = submoduleEntry ? null : summaries.find((s) => s.path === path);
      if (!submoduleEntry && !summary) return null;
      const signal = abortRef.current?.signal;
      const result = submoduleEntry
        ? effectiveThreadId
          ? await gitApi.getSubmoduleFileDiff(
              effectiveThreadId,
              submoduleEntry.submodulePath,
              submoduleEntry.innerPath,
              submoduleEntry.staged,
              signal,
              'full',
            )
          : await gitApi.projectSubmoduleFileDiff(
              projectModeId!,
              submoduleEntry.submodulePath,
              submoduleEntry.innerPath,
              submoduleEntry.staged,
              signal,
              'full',
            )
        : effectiveThreadId
          ? await gitApi.getFileDiff(effectiveThreadId, path, summary!.staged, signal, 'full')
          : await gitApi.projectFileDiff(projectModeId!, path, summary!.staged, signal, 'full');
      if (result.isOk() && !signal?.aborted) {
        return {
          oldValue: parseDiffOld(result.value.diff),
          newValue: parseDiffNew(result.value.diff),
          rawDiff: result.value.diff,
        };
      }
      return null;
    },
    [hasGitContext, summaries, effectiveThreadId, projectModeId, resolveSubmoduleEntry],
  );

  // Load diff when selected file changes. Skip when refresh() is running — it
  // already loads the diff for the selected file inline, so firing here would
  // cause a duplicate request.
  useEffect(() => {
    if (selectedFile && !diffCache.has(selectedFile) && !refreshingRef.current) {
      loadDiffForFile(selectedFile);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only trigger on file selection change; diffCache/loadDiffForFile change on every refresh and would cause loops
  }, [selectedFile]);

  // Load diff when expanded file changes.
  useEffect(() => {
    if (expandedFile && !diffCache.has(expandedFile)) {
      loadDiffForFile(expandedFile);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only trigger on expanded file change; diffCache/loadDiffForFile change on every refresh and would cause loops
  }, [expandedFile]);

  // Fire deferred refresh when the review pane becomes visible. Uses the
  // needsRefreshRef flag set by the parent's gitContextKey reset effect when
  // the pane is hidden.
  useEffect(() => {
    if (reviewPaneOpen && needsRefreshRef.current) {
      needsRefreshRef.current = false;
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh changes every render; only trigger on pane visibility change
  }, [reviewPaneOpen]);

  // Ensure the visible Changes tab loads its summary, once per (context +
  // git-status snapshot). This single effect covers two cases that used to be
  // separate (and raced each other):
  //   1. Initial mount while already open — status may not be hydrated yet
  //      (snapshot 0:0:0); we still fire one load.
  //   2. Recovery — git status later reports a dirty worktree while the summary
  //      is still empty (an earlier refresh was missed/aborted during thread or
  //      right-pane hydration); the changed snapshot re-fires the load once.
  // The parent reset effect (use-review-state) is still the primary refresh on
  // context change; this is the local "if visible and empty, load once" guard.
  // Keying on the status snapshot caps it at one refresh per snapshot, so a
  // genuinely empty worktree can't loop.
  useEffect(() => {
    // NOTE: `loadError` is intentionally NOT a bail condition. A failed initial
    // refresh (e.g. the runner was still reconnecting on app entry) must not
    // permanently block recovery — when fresh git-status info later arrives the
    // key below changes and we retry. The per-snapshot key still caps retries to
    // one per status change, so a genuinely failing context can't tight-loop.
    if (!reviewPaneOpen || !hasGitContext || summaries.length > 0 || loading) {
      if (!hasGitContext || summaries.length > 0) {
        ensureLoadedKeyRef.current = null;
      }
      return;
    }

    const key = [
      effectiveThreadId ?? projectModeId ?? 'unknown',
      dirtyFileCount ?? 0,
      linesAdded ?? 0,
      linesDeleted ?? 0,
    ].join(':');
    if (ensureLoadedKeyRef.current === key) return;
    ensureLoadedKeyRef.current = key;
    refresh();
  }, [
    reviewPaneOpen,
    hasGitContext,
    effectiveThreadId,
    projectModeId,
    dirtyFileCount,
    linesAdded,
    linesDeleted,
    summaries.length,
    loading,
    loadError,
    refresh,
  ]);

  // Auto-refresh diffs when agent modifies files (debounced 2s).
  useAutoRefreshDiff(effectiveThreadId, refresh, 2000, reviewPaneOpen);

  return {
    diffCache,
    loadingDiff,
    loading,
    loadError,
    loadErrorMessage,
    truncatedInfo,
    setDiffCache,
    setLoadError,
    setLoadErrorMessage,
    abortRef,
    needsRefreshRef,
    refresh,
    loadDiffForFile,
    requestFullDiff,
  };
}
