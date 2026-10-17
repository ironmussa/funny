import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';

import {
  applyDragRange,
  selectionStateOf,
  toggleHunk,
  toggleLine,
  type LineSelectionState,
} from '@/lib/diff-line-selection';
import { isOneSidedDiff } from '@/lib/diff-math';
import { isMarkdownFile } from '@/lib/markdown-file';
import { getChangeableIndices, parseRawDiff } from '@/lib/patch-builder';

import type { DiffViewMode } from '../VirtualDiff';

/* ── Shared state for the expanded diff dialog + inline view ── */

export interface FullDiffResult {
  oldValue: string;
  newValue: string;
  rawDiff?: string;
}

export type RequestFullDiff = (filePath: string) => Promise<FullDiffResult | null>;

export interface DiffValues {
  rawDiff?: string;
  oldValue: string;
  newValue: string;
}

/** The full-file diff replaces the base values only while "show full file" is on and loaded. */
export function resolveEffectiveDiff(
  fullDiff: FullDiffResult | undefined,
  showFullFile: boolean,
  base: DiffValues,
): DiffValues {
  if (showFullFile && fullDiff) {
    return { rawDiff: fullDiff.rawDiff, oldValue: fullDiff.oldValue, newValue: fullDiff.newValue };
  }
  return base;
}

/**
 * Derive the display mode: one-sided diffs (created / fully deleted files) are
 * forced to unified ('1 column') since split/three-pane would render an empty
 * column — derived from content so it holds without a `files` status too.
 */
export function deriveDiffDisplay(input: {
  filePath: string;
  status?: string;
  effective: DiffValues;
  userViewMode: DiffViewMode;
  forceUnified: boolean;
  isDeletedFile: boolean;
  hasFullDiffProvider: boolean;
  markdownPreviewPath: string | null;
}) {
  const isOneSided = isOneSidedDiff({ status: input.status, ...input.effective });
  const viewMode: DiffViewMode = input.forceUnified || isOneSided ? 'unified' : input.userViewMode;
  const canPreviewMarkdown =
    isMarkdownFile(input.filePath) && !input.isDeletedFile && input.hasFullDiffProvider;
  const showMarkdownPreview = canPreviewMarkdown && input.markdownPreviewPath === input.filePath;
  return { isOneSided, viewMode, canPreviewMarkdown, showMarkdownPreview };
}

export type DiffDisplay = ReturnType<typeof deriveDiffDisplay>;

/* ── Search ── */

function useDiffSearch() {
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [totalMatches, setTotalMatches] = useState(0);

  const openSearch = useCallback(() => setShowSearch(true), []);

  const closeSearch = useCallback(() => {
    setShowSearch(false);
    setSearchQuery('');
    setCurrentMatchIndex(0);
    setTotalMatches(0);
  }, []);

  const toggleSearch = useCallback(() => {
    if (showSearch) closeSearch();
    else setShowSearch(true);
  }, [showSearch, closeSearch]);

  const changeQuery = useCallback((value: string) => {
    setSearchQuery(value);
    setCurrentMatchIndex(0);
  }, []);

  const changeCaseSensitive = useCallback((value: boolean) => {
    setSearchCaseSensitive(value);
    setCurrentMatchIndex(0);
  }, []);

  const goToNextMatch = useCallback(() => {
    if (totalMatches === 0) return;
    setCurrentMatchIndex((prev) => (prev + 1) % totalMatches);
  }, [totalMatches]);

  const goToPrevMatch = useCallback(() => {
    if (totalMatches === 0) return;
    setCurrentMatchIndex((prev) => (prev - 1 + totalMatches) % totalMatches);
  }, [totalMatches]);

  const handleMatchCount = useCallback((count: number) => {
    setTotalMatches(count);
    setCurrentMatchIndex((prev) => (count === 0 ? 0 : Math.min(prev, count - 1)));
  }, []);

  return {
    showSearch,
    searchQuery,
    searchCaseSensitive,
    currentMatchIndex,
    totalMatches,
    openSearch,
    closeSearch,
    toggleSearch,
    changeQuery,
    changeCaseSensitive,
    goToNextMatch,
    goToPrevMatch,
    handleMatchCount,
  };
}

export type DiffSearch = ReturnType<typeof useDiffSearch>;

/* ── Full-file diff cache ── */

function useFullDiffCache(filePath: string, onRequestFullDiff: RequestFullDiff | undefined) {
  const [fullDiffCache, setFullDiffCache] = useState<Map<string, FullDiffResult>>(new Map());
  const [loadingFullDiff, setLoadingFullDiff] = useState(false);

  const requestFullFile = useCallback(async () => {
    const cached = fullDiffCache.get(filePath);
    if (cached) return cached;
    if (!onRequestFullDiff) return null;

    setLoadingFullDiff(true);
    try {
      const result = await onRequestFullDiff(filePath);
      if (!result) return null;
      setFullDiffCache((prev) => new Map(prev).set(filePath, result));
      return result;
    } finally {
      setLoadingFullDiff(false);
    }
  }, [filePath, fullDiffCache, onRequestFullDiff]);

  return { fullDiff: fullDiffCache.get(filePath), loadingFullDiff, requestFullFile };
}

/* ── Toolbar controls (view mode, wrap, full file, markdown preview, search) ── */

export function useExpandedDiffControls({
  filePath,
  onRequestFullDiff,
  initialViewMode,
}: {
  filePath: string;
  onRequestFullDiff?: RequestFullDiff;
  initialViewMode: DiffViewMode;
}) {
  const [userViewMode, setUserViewMode] = useState<DiffViewMode>(initialViewMode);
  const [wordWrap, setWordWrap] = useState(false);
  const [showFullFile, setShowFullFile] = useState(false);
  const [markdownPreviewPath, setMarkdownPreviewPath] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const { fullDiff, loadingFullDiff, requestFullFile } = useFullDiffCache(
    filePath,
    onRequestFullDiff,
  );
  const search = useDiffSearch();
  const { closeSearch } = search;

  // Reset search + full-file mode whenever the file changes
  const [searchFilePath, setSearchFilePath] = useState(filePath);
  if (searchFilePath !== filePath) {
    setSearchFilePath(filePath);
    closeSearch();
    setShowFullFile(false);
  }

  const handleViewModeChange = useCallback((value: string) => {
    if (!value) return;
    startTransition(() => setUserViewMode(value as DiffViewMode));
  }, []);

  const toggleWordWrap = useCallback(() => setWordWrap((w) => !w), []);

  const toggleFullFile = useCallback(async () => {
    if (showFullFile) {
      startTransition(() => setShowFullFile(false));
      return;
    }
    if (!onRequestFullDiff || (await requestFullFile())) {
      startTransition(() => setShowFullFile(true));
    }
  }, [showFullFile, onRequestFullDiff, requestFullFile]);

  const toggleMarkdownPreview = useCallback(async () => {
    if (markdownPreviewPath === filePath) {
      setMarkdownPreviewPath(null);
      return;
    }

    if (onRequestFullDiff && !(await requestFullFile())) return;

    closeSearch();
    setMarkdownPreviewPath(filePath);
  }, [markdownPreviewPath, filePath, onRequestFullDiff, requestFullFile, closeSearch]);

  const clearMarkdownPreview = useCallback(() => setMarkdownPreviewPath(null), []);

  return {
    userViewMode,
    handleViewModeChange,
    isPending,
    wordWrap,
    toggleWordWrap,
    showFullFile,
    toggleFullFile,
    fullDiff,
    loadingFullDiff,
    requestFullFile,
    markdownPreviewPath,
    toggleMarkdownPreview,
    clearMarkdownPreview,
    search,
  };
}

export type ExpandedDiffControls = ReturnType<typeof useExpandedDiffControls>;

/* ── Keyboard shortcuts ── */

/**
 * Global Ctrl/Cmd+F / Escape handler — uses a capture-phase window listener so
 * it works even when focus is on a nested element (or the view is rendered via
 * portal). stopImmediatePropagation prevents other capture-phase listeners
 * (e.g. ThreadView search) from also firing.
 */
export function useDiffKeyboardShortcuts({
  enabled,
  canOpenSearch,
  search,
  onIdleEscape,
}: {
  enabled: boolean;
  canOpenSearch: boolean;
  search: Pick<DiffSearch, 'showSearch' | 'openSearch' | 'closeSearch'>;
  /** Called on Escape when the search bar is not open */
  onIdleEscape?: () => void;
}) {
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f' && canOpenSearch) {
      e.preventDefault();
      e.stopImmediatePropagation();
      search.openSearch();
      return;
    }
    if (e.key !== 'Escape') return;
    if (search.showSearch) {
      e.preventDefault();
      e.stopImmediatePropagation();
      search.closeSearch();
    } else {
      onIdleEscape?.();
    }
  });

  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => onKey(e);
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [enabled]);
}

/* ── Line selection for partial staging ── */

export function useDiffLineSelection({
  filePath,
  selectable,
  diffText,
  selectAllSignal,
  deselectAllSignal,
  onSelectionStateChange,
}: {
  filePath: string;
  selectable: boolean;
  diffText: string | undefined;
  selectAllSignal: number;
  deselectAllSignal: number;
  onSelectionStateChange?: (filePath: string, state: LineSelectionState) => void;
}) {
  const allChangeableIndices = useMemo(() => {
    if (!selectable || !diffText) return new Set<number>();
    return getChangeableIndices(parseRawDiff(diffText));
  }, [selectable, diffText]);

  const selectionSource = `${filePath}\u0000${selectable}\u0000${diffText ?? ''}`;
  const initialSelectedLines = selectable ? allChangeableIndices : new Set<number>();
  const [selection, setSelection] = useState(() => ({
    source: selectionSource,
    selectSignal: selectAllSignal,
    deselectSignal: deselectAllSignal,
    lines: new Set(initialSelectedLines),
  }));

  const sourceChanged = selection.source !== selectionSource;
  const selectRequested = selection.selectSignal !== selectAllSignal;
  if (sourceChanged || selectRequested || selection.deselectSignal !== deselectAllSignal) {
    setSelection({
      source: selectionSource,
      selectSignal: selectAllSignal,
      deselectSignal: deselectAllSignal,
      lines: sourceChanged || selectRequested ? new Set(initialSelectedLines) : new Set<number>(),
    });
  }

  const selectedLines = selection.lines;

  const commitSelection = useCallback(
    (lines: Set<number>) => {
      setSelection((current) => ({ ...current, lines }));
      if (!selectable || !onSelectionStateChange) return;
      onSelectionStateChange(filePath, selectionStateOf(lines, allChangeableIndices.size));
    },
    [selectable, onSelectionStateChange, allChangeableIndices.size, filePath],
  );

  const handleLineToggle = useCallback(
    (lineIdx: number) => commitSelection(toggleLine(selectedLines, lineIdx)),
    [selectedLines, commitSelection],
  );

  const handleHunkToggle = useCallback(
    (hunkLineIndices: number[]) => commitSelection(toggleHunk(selectedLines, hunkLineIndices)),
    [selectedLines, commitSelection],
  );

  // Snapshot of selectedLines at drag start — used to revert lines outside the drag range
  const dragSnapshotRef = useRef<Set<number> | null>(null);

  const handleDragSelect = useCallback(
    (startLineIdx: number, endLineIdx: number, select: boolean) => {
      // Save snapshot on first call of a drag (when snapshot is null)
      if (!dragSnapshotRef.current) {
        dragSnapshotRef.current = new Set(selectedLines);
      }
      const snapshot = dragSnapshotRef.current;
      commitSelection(
        applyDragRange(snapshot, allChangeableIndices, startLineIdx, endLineIdx, select),
      );
    },
    [allChangeableIndices, selectedLines, commitSelection],
  );

  // Clear drag snapshot on mouseup
  useEffect(() => {
    const handler = () => {
      dragSnapshotRef.current = null;
    };
    window.addEventListener('mouseup', handler);
    return () => window.removeEventListener('mouseup', handler);
  }, []);

  return { selectedLines, handleLineToggle, handleHunkToggle, handleDragSelect };
}

export type DiffLineSelection = ReturnType<typeof useDiffLineSelection>;

/** VirtualDiff selection props — selection is only available in unified mode. */
export function lineSelectionProps(active: boolean, selection: DiffLineSelection) {
  if (!active) return { selectable: false };
  return {
    selectable: true,
    selectedLines: selection.selectedLines,
    onLineToggle: selection.handleLineToggle,
    onHunkToggle: selection.handleHunkToggle,
    onDragSelect: selection.handleDragSelect,
  };
}
