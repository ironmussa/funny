import type { DiffSummaryResponse, FileDiffSummary } from '@funny/shared';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';

import { fetchForThread, fetchProjectStatus } from '@/data/git-status/actions';
import { useAutoRefreshDiff } from '@/hooks/use-auto-refresh-diff';
import { useLoadDiffWhenMissing } from '@/hooks/use-load-diff-when-missing';
import { useStableCallback } from '@/hooks/use-stable-callback';
import { gitApi } from '@/lib/api/git';
import { parseDiffOld, parseDiffNew } from '@/lib/diff-parse';
import { metric } from '@/lib/telemetry';
import { withCleanup } from '@/lib/while-pending';

interface UseDiffDataArgs {
  hasGitContext: boolean;
  effectiveThreadId: string | undefined;
  projectModeId: string | null;
  selectedFile: string | null;
  expandedFile: string | null;
  reviewPaneOpen: boolean;
  /** Branch known for the current git context; local-thread checkout hydrates async. */
  currentBranch?: string;
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
 * The id dirty signals for this review are keyed on. Project mode has no
 * thread: project-scoped dirty signals use the project id.
 */
function dirtySignalScope(
  threadId: string | undefined,
  projectModeId: string | null,
): string | undefined {
  return threadId ?? projectModeId ?? undefined;
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
/** A file whose diff a refresh reloads, with the side (staged or not) it shows. */
interface DiffLoad {
  path: string;
  staged: boolean;
}

/**
 * What a refresh reloads: the selected file (or the first one when the
 * selection is gone) and the expanded file when it is a different one.
 */
function planDiffReload(
  files: FileDiffSummary[],
  selectedFile: string | null,
  expandedFile: string | null,
): { fileToLoad: string | null; loads: DiffLoad[] } {
  const paths = new Set(files.map((f) => f.path));
  const fileToLoad = pickFileToLoad(files, paths, selectedFile);
  const expanded = pickExpandedFile(paths, expandedFile, fileToLoad);
  const loads = [loadFor(files, fileToLoad), loadFor(files, expanded)].filter(
    (load): load is DiffLoad => load !== null,
  );
  return { fileToLoad, loads };
}

function pickFileToLoad(
  files: FileDiffSummary[],
  paths: Set<string>,
  selectedFile: string | null,
): string | null {
  if (selectedFile && paths.has(selectedFile)) return selectedFile;
  return firstPath(files);
}

function firstPath(files: FileDiffSummary[]): string | null {
  return files[0]?.path ?? null;
}

function pickExpandedFile(
  paths: Set<string>,
  expandedFile: string | null,
  fileToLoad: string | null,
): string | null {
  return expandedFile && expandedFile !== fileToLoad && paths.has(expandedFile)
    ? expandedFile
    : null;
}

function loadFor(files: FileDiffSummary[], path: string | null): DiffLoad | null {
  const summary = path ? files.find((s) => s.path === path) : undefined;
  return summary ? { path: summary.path, staged: summary.staged } : null;
}

/**
 * The checked files after a refresh: files that left the list are dropped, and
 * new files are checked when nothing was checked or the list grew. An empty
 * result checks every file.
 */
function nextCheckedFiles(prev: Set<string>, files: FileDiffSummary[]): Set<string> {
  const paths = files.map((f) => f.path);
  const current = new Set(paths);
  const next = new Set([...prev].filter((p) => current.has(p)));
  if (shouldCheckNewFiles(prev, files.length)) for (const path of paths) next.add(path);
  return next.size === 0 ? new Set(paths) : next;
}

function shouldCheckNewFiles(prev: Set<string>, fileCount: number): boolean {
  return prev.size === 0 || fileCount > prev.size;
}

interface DiffTarget {
  effectiveThreadId: string | undefined;
  projectModeId: string | null;
}

interface SubmoduleEntry {
  submodulePath: string;
  innerPath: string;
  staged: boolean;
}

/**
 * Fetch one file's diff for the thread (or project) in view. A file inside an
 * expanded submodule is fetched through the submodule endpoint.
 */
function fetchEntryDiff(
  { effectiveThreadId, projectModeId }: DiffTarget,
  filePath: string,
  entry: SubmoduleEntry | { staged: boolean },
  signal: AbortSignal | undefined,
  context?: 'full',
) {
  if ('submodulePath' in entry) {
    return effectiveThreadId
      ? gitApi.getSubmoduleFileDiff(
          effectiveThreadId,
          entry.submodulePath,
          entry.innerPath,
          entry.staged,
          signal,
          context,
        )
      : gitApi.projectSubmoduleFileDiff(
          projectModeId!,
          entry.submodulePath,
          entry.innerPath,
          entry.staged,
          signal,
          context,
        );
  }
  return effectiveThreadId
    ? gitApi.getFileDiff(effectiveThreadId, filePath, entry.staged, signal, context)
    : gitApi.projectFileDiff(projectModeId!, filePath, entry.staged, signal, context);
}

export function useDiffData({
  hasGitContext,
  effectiveThreadId,
  projectModeId,
  selectedFile,
  expandedFile,
  reviewPaneOpen,
  currentBranch,
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
    (filePath: string): SubmoduleEntry | null => {
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
    if (effectiveThreadId) fetchForThread(effectiveThreadId);
    else if (projectModeId) fetchProjectStatus(projectModeId);

    const target = effectiveThreadId ?? projectModeId ?? 'unknown';
    const isStale = () => refreshEpochRef.current !== epoch || signal.aborted;

    const fetchSummary = () =>
      effectiveThreadId
        ? gitApi.getDiffSummary(effectiveThreadId, undefined, undefined, signal)
        : gitApi.projectDiffSummary(projectModeId!, undefined, undefined, signal);

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

    // Superseded by a newer refresh, or this request was aborted (context
    // reset / thread switch): no state is written; the cleanup below still
    // clears `loading` when this is the live epoch.
    const discardRefresh = () => {
      // Permanent diagnostic: a discarded refresh is the prime suspect when
      // the Changes tab shows "No changes" on a dirty tree (result arrived
      // but was thrown away by the epoch/abort guard). See instrumentation
      // notes in packages/client/CLAUDE.md.
      metric('review.refresh_outcome', 1, {
        attributes: { outcome: signal.aborted ? 'aborted' : 'superseded', threadId: target },
      });
      // This refresh's result was thrown away, so `summaries` may still be the
      // empty array the reset effect left behind. Release the ensure-loaded
      // latch so its backstop effect re-fires and reloads the *settled*
      // context — otherwise a summary discarded during a thread switch leaves
      // the Changes tab stuck on "No changes" even though the tree is dirty.
      ensureLoadedKeyRef.current = null;
    };

    const reportLoadError = (error: { message: string }) => {
      console.error('Failed to load diff summary:', error);
      metric('review.refresh_outcome', 1, {
        attributes: { outcome: 'error', error: error.message, threadId: target },
      });
      setLoadError(true);
      setLoadErrorMessage(error.message);
    };

    const applySummary = async (data: DiffSummaryResponse) => {
      metric('review.refresh_outcome', 1, {
        attributes: { outcome: 'applied', files: String(data.files.length), threadId: target },
      });
      // Decide which visible files to reload before the state updates, so their
      // diff requests run in parallel with React batching.
      const plan = planDiffReload(data.files, selectedFile, expandedFile);
      setSummaries(data.files);
      setTruncatedInfo({ total: data.total, truncated: data.truncated });
      // A refresh means git state may have changed even if the same file paths
      // are still present. Clear stale per-path diffs before any fresh visible
      // diff responses can populate the cache again.
      setDiffCache(new Map());
      // Start visible diff fetches after publishing the summary, so the file
      // list does not depend on single-file diff timing.
      const diffLoads = signal.aborted
        ? []
        : plan.loads.map((load) => fetchFreshDiff(load.path, load.staged));
      setCheckedFiles((prev) => nextCheckedFiles(prev, data.files));
      if (plan.fileToLoad !== selectedFile) setSelectedFile(plan.fileToLoad);
      await Promise.all(diffLoads);
    };

    await withCleanup(
      async () => {
        const result = await fetchSummary();
        if (isStale()) return discardRefresh();
        if (result.isErr()) return reportLoadError(result.error);
        await applySummary(result.value);
      },
      () => {
        // Only the live refresh owns `loading`. A superseded refresh leaves the
        // flag to its successor; the live one always clears it — even if its
        // fetch was aborted — so the Changes tab never gets stuck on the spinner.
        if (refreshEpochRef.current === epoch) {
          // The epoch check gives the latest refresh exclusive ownership of loading.
          // react-doctor-disable-next-line no-loading-flag-reset-outside-finally
          setLoading(false);
          refreshingRef.current = false;
        }
      },
    );
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
      const result = await fetchEntryDiff(
        { effectiveThreadId, projectModeId },
        filePath,
        submoduleEntry ?? { staged: summary!.staged },
        signal,
      );
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
      const result = await fetchEntryDiff(
        { effectiveThreadId, projectModeId },
        path,
        submoduleEntry ?? { staged: summary!.staged },
        signal,
        'full',
      );
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
  const loadSelectedFileDiff = useStableCallback((path: string) => {
    if (!diffCache.has(path) && !refreshingRef.current) loadDiffForFile(path);
  });
  useEffect(() => {
    if (selectedFile) loadSelectedFileDiff(selectedFile);
  }, [selectedFile, loadSelectedFileDiff]);

  // Load diff when expanded file changes.
  useLoadDiffWhenMissing(expandedFile, diffCache, loadDiffForFile);

  // Fire deferred refresh when the review pane becomes visible. Uses the
  // needsRefreshRef flag set by the parent's gitContextKey reset effect when
  // the pane is hidden.
  const runDeferredRefresh = useStableCallback(() => {
    if (needsRefreshRef.current) {
      needsRefreshRef.current = false;
      refresh();
    }
  });
  useEffect(() => {
    if (reviewPaneOpen) runDeferredRefresh();
  }, [reviewPaneOpen, runDeferredRefresh]);

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
      currentBranch ?? 'unknown-branch',
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
    currentBranch,
    dirtyFileCount,
    linesAdded,
    linesDeleted,
    summaries.length,
    loading,
    loadError,
    refresh,
  ]);

  // Auto-refresh diffs when agent modifies files (debounced 2s).
  useAutoRefreshDiff(
    dirtySignalScope(effectiveThreadId, projectModeId),
    refresh,
    2000,
    reviewPaneOpen,
  );

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
