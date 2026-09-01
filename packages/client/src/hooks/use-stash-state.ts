import type { FileDiffSummary } from '@funny/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { gitApi } from '@/lib/api/git';
import type { ReviewSubTab } from '@/stores/ui-store';

interface StashEntry {
  index: string;
  message: string;
  relativeDate: string;
}

interface StashFile {
  path: string;
  additions: number;
  deletions: number;
}

interface UseStashStateArgs {
  hasGitContext: boolean;
  effectiveThreadId: string | undefined;
  projectModeId: string | null;
  currentBranch: string | undefined;
  abortRef: React.MutableRefObject<AbortController | null>;
  reviewPaneOpen: boolean;
  reviewSubTab: ReviewSubTab;
  /** Trigger a full refresh of the surrounding ReviewPane after a stash op. */
  refresh: () => Promise<void> | void;
  /** Recomputes when the git context (thread/project) changes. */
  gitContextKey: string;
}

export interface UseStashStateResult {
  stashEntries: StashEntry[];
  filteredStashEntries: StashEntry[];
  selectedStashIndex: string | null;
  setSelectedStashIndex: (s: string | null) => void;
  selectedStashEntry: StashEntry | null;
  stashFiles: StashFile[];
  stashTreeFiles: FileDiffSummary[];
  stashFilesLoading: boolean;
  stashDialogFile: string | null;
  stashDialogDiff: string | null;
  stashDialogDiffLoading: boolean;
  stashDialogDiffCache: Map<string, string>;
  stashFileSearch: string;
  setStashFileSearch: (s: string) => void;
  stashFileSearchCaseSensitive: boolean;
  setStashFileSearchCaseSensitive: (b: boolean) => void;
  stashPopInProgress: boolean;
  stashDropInProgress: string | null;
  handleStashPop: () => Promise<void>;
  /** Drops a stash by index. Caller is expected to gate this with a confirm dialog. */
  executeStashDrop: (stashIndex: string) => Promise<void>;
  loadStashFileDiff: (index: string, filePath: string) => Promise<void>;
  /** Re-fetches the stash list from the server. Called after creating a new stash. */
  refreshStashList: () => Promise<void>;
}

/**
 * Owns all stash-related state for ReviewPane: list, selection, file diffs,
 * pop/drop operations, and the lazy-load effect tied to the stash sub-tab.
 *
 * Extracted from ReviewPane.tsx as part of the god-file split — see
 * .claude/plans/reviewpane-split.md for the full plan.
 */
export function useStashState({
  hasGitContext,
  effectiveThreadId,
  projectModeId,
  currentBranch,
  abortRef,
  reviewPaneOpen,
  reviewSubTab,
  refresh,
  gitContextKey,
}: UseStashStateArgs): UseStashStateResult {
  const [stashEntries, setStashEntries] = useState<StashEntry[]>([]);
  const [stashPopInProgress, setStashPopInProgress] = useState(false);
  const [stashDropInProgress, setStashDropInProgress] = useState<string | null>(null);
  const [selectedStashIndex, setSelectedStashIndex] = useState<string | null>(null);
  const [stashFiles, setStashFiles] = useState<StashFile[]>([]);
  const [stashFilesLoading, setStashFilesLoading] = useState(false);
  const [stashDialogFile, setStashDialogFile] = useState<string | null>(null);
  const [stashDialogDiff, setStashDialogDiff] = useState<string | null>(null);
  const [stashDialogDiffLoading, setStashDialogDiffLoading] = useState(false);
  const [stashFileSearch, setStashFileSearch] = useState('');
  const [stashFileSearchCaseSensitive, setStashFileSearchCaseSensitive] = useState(false);

  // Filter stash entries to only show those from the current branch.
  // Stash messages have format: "On <branch>: <message>" or "WIP on <branch>: <message>".
  const filteredStashEntries = useMemo(() => {
    if (!currentBranch) return stashEntries;
    return stashEntries.filter((e) => {
      const match = e.message.match(/^(?:WIP )?[Oo]n ([^:]+):/);
      return match ? match[1] === currentBranch : true;
    });
  }, [stashEntries, currentBranch]);

  const refreshStashList = useCallback(async () => {
    if (!hasGitContext) return;
    const signal = abortRef.current?.signal;
    const result = effectiveThreadId
      ? await gitApi.stashList(effectiveThreadId, signal)
      : await gitApi.projectStashList(projectModeId!, signal);
    if (result.isOk() && !signal?.aborted) {
      setStashEntries(result.value.entries);
    }
  }, [hasGitContext, effectiveThreadId, projectModeId, abortRef]);

  const handleStashPop = useCallback(async () => {
    if (!hasGitContext || stashPopInProgress) return;
    setStashPopInProgress(true);
    const result = effectiveThreadId
      ? await gitApi.stashPop(effectiveThreadId)
      : await gitApi.projectStashPop(projectModeId!);
    if (result.isErr()) {
      toast.error(`Stash pop failed: ${result.error.message}`);
    } else {
      toast.success('Stash applied');
    }
    setStashPopInProgress(false);
    await refresh();
    refreshStashList();
  }, [
    hasGitContext,
    stashPopInProgress,
    effectiveThreadId,
    projectModeId,
    refresh,
    refreshStashList,
  ]);

  const executeStashDrop = useCallback(
    async (stashIndex: string) => {
      if (!hasGitContext || stashDropInProgress) return;
      setStashDropInProgress(stashIndex);
      const result = effectiveThreadId
        ? await gitApi.stashDrop(effectiveThreadId, stashIndex)
        : await gitApi.projectStashDrop(projectModeId!, stashIndex);
      if (result.isErr()) {
        toast.error(`Drop stash failed: ${result.error.message}`);
      } else {
        toast.success('Stash discarded');
      }
      setStashDropInProgress(null);
      setSelectedStashIndex(null);
      setStashFiles([]);
      await refresh();
      refreshStashList();
    },
    [
      hasGitContext,
      stashDropInProgress,
      effectiveThreadId,
      projectModeId,
      refresh,
      refreshStashList,
    ],
  );

  const loadStashFileDiff = useCallback(
    async (index: string, filePath: string) => {
      if (!hasGitContext) return;
      setStashDialogFile(filePath);
      setStashDialogDiffLoading(true);
      setStashDialogDiff(null);
      try {
        const result = effectiveThreadId
          ? await gitApi.stashFileDiff(effectiveThreadId, index, filePath)
          : await gitApi.projectStashFileDiff(projectModeId!, index, filePath);
        if (result.isOk()) setStashDialogDiff(result.value.diff);
        else toast.error(`Failed to load diff: ${result.error.message}`);
      } finally {
        setStashDialogDiffLoading(false);
      }
    },
    [hasGitContext, effectiveThreadId, projectModeId],
  );

  // Lazy: load the stash list only when the stash sub-tab is visible. Loading
  // it on every git-context change wastes git requests when the user only
  // looks at the Changes tab.
  useEffect(() => {
    if (reviewPaneOpen && reviewSubTab === 'stash') {
      refreshStashList();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only re-runs on context/visibility/tab change
  }, [gitContextKey, reviewPaneOpen, reviewSubTab]);

  // When a stash is selected, load its file list + first diff.
  useEffect(() => {
    if (!selectedStashIndex || !hasGitContext) {
      setStashFiles([]);
      setStashDialogFile(null);
      setStashDialogDiff(null);
      setStashFileSearch('');
      return;
    }
    let cancelled = false;
    setStashFilesLoading(true);
    setStashFileSearch('');
    const load = async () => {
      try {
        const filesResult = effectiveThreadId
          ? await gitApi.stashShow(effectiveThreadId, selectedStashIndex)
          : await gitApi.projectStashShow(projectModeId!, selectedStashIndex);
        if (cancelled) return;
        if (filesResult.isOk()) {
          setStashFiles(filesResult.value.files);
          if (filesResult.value.files.length > 0) {
            const firstPath = filesResult.value.files[0].path;
            setStashDialogFile(firstPath);
            setStashDialogDiffLoading(true);
            setStashDialogDiff(null);
            try {
              const diffResult = effectiveThreadId
                ? await gitApi.stashFileDiff(effectiveThreadId, selectedStashIndex, firstPath)
                : await gitApi.projectStashFileDiff(projectModeId!, selectedStashIndex, firstPath);
              if (!cancelled && diffResult.isOk()) setStashDialogDiff(diffResult.value.diff);
            } finally {
              if (!cancelled) setStashDialogDiffLoading(false);
            }
          }
        } else {
          toast.error(`Failed to load stash files: ${filesResult.error.message}`);
          setStashFiles([]);
        }
      } finally {
        if (!cancelled) setStashFilesLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [selectedStashIndex, hasGitContext, effectiveThreadId, projectModeId]);

  // Treeview data for the stash detail dialog.
  const stashTreeFiles = useMemo<FileDiffSummary[]>(() => {
    const all: FileDiffSummary[] = stashFiles.map((f) => ({
      path: f.path,
      status: 'modified',
      staged: false,
      additions: f.additions,
      deletions: f.deletions,
    }));
    if (!stashFileSearch.trim()) return all;
    if (stashFileSearchCaseSensitive) {
      return all.filter((f) => f.path.includes(stashFileSearch));
    }
    const q = stashFileSearch.toLowerCase();
    return all.filter((f) => f.path.toLowerCase().includes(q));
  }, [stashFiles, stashFileSearch, stashFileSearchCaseSensitive]);

  const selectedStashEntry = useMemo(() => {
    if (!selectedStashIndex) return null;
    return (
      stashEntries.find(
        (e) => e.index.replace('stash@{', '').replace('}', '') === selectedStashIndex,
      ) ?? null
    );
  }, [selectedStashIndex, stashEntries]);

  const stashDialogDiffCache = useMemo(() => {
    const m = new Map<string, string>();
    if (stashDialogFile && stashDialogDiff) m.set(stashDialogFile, stashDialogDiff);
    return m;
  }, [stashDialogFile, stashDialogDiff]);

  return {
    stashEntries,
    filteredStashEntries,
    selectedStashIndex,
    setSelectedStashIndex,
    selectedStashEntry,
    stashFiles,
    stashTreeFiles,
    stashFilesLoading,
    stashDialogFile,
    stashDialogDiff,
    stashDialogDiffLoading,
    stashDialogDiffCache,
    stashFileSearch,
    setStashFileSearch,
    stashFileSearchCaseSensitive,
    setStashFileSearchCaseSensitive,
    stashPopInProgress,
    stashDropInProgress,
    handleStashPop,
    executeStashDrop,
    loadStashFileDiff,
    refreshStashList,
  };
}
