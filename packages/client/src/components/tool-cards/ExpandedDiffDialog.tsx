import type { FileDiffSummary, PRReviewThread } from '@funny/shared';
import {
  Check,
  Columns3,
  Columns2,
  FileCode,
  FileText,
  Loader2,
  MessageSquare,
  RectangleVertical,
  Search,
  WrapText,
  X,
} from 'lucide-react';
import {
  type ComponentType,
  useState,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useTransition,
} from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SearchBar } from '@/components/ui/search-bar';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { TriCheckbox } from '@/components/ui/tri-checkbox';
import { parseRawDiff, buildPatchFromSelection, getChangeableIndices } from '@/lib/patch-builder';
import { cn } from '@/lib/utils';

import { DiffCommentThread } from '../DiffCommentThread';
import { FileTree } from '../FileTree';
import { type DiffViewMode, type ConflictResolution, VirtualDiff } from '../VirtualDiff';
import { getFileName } from './format-utils';

/* ── Helpers ── */

/**
 * Compute a minimal unified diff from old/new strings.
 * Used when we only have tool call old_string/new_string (no raw git diff).
 */
function computeUnifiedDiff(oldValue: string, newValue: string): string {
  const oldLines = oldValue.split('\n');
  const newLines = newValue.split('\n');
  const lines: string[] = [];

  lines.push(`--- a/file`);
  lines.push(`+++ b/file`);

  // Simple diff: show all removals then all additions
  // For a more accurate diff, we'd use an LCS algorithm, but this is sufficient
  // for the inline edit card use case where changes are small and localized.
  // We use a basic approach: find common prefix/suffix, diff the middle.
  let prefixLen = 0;
  while (
    prefixLen < oldLines.length &&
    prefixLen < newLines.length &&
    oldLines[prefixLen] === newLines[prefixLen]
  ) {
    prefixLen++;
  }

  let suffixLen = 0;
  while (
    suffixLen < oldLines.length - prefixLen &&
    suffixLen < newLines.length - prefixLen &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const oldChanged = oldLines.slice(prefixLen, oldLines.length - suffixLen);
  const newChanged = newLines.slice(prefixLen, newLines.length - suffixLen);

  // Context lines before change
  const ctxBefore = Math.min(prefixLen, 3);
  const ctxAfter = Math.min(suffixLen, 3);

  const hunkOldStart = prefixLen - ctxBefore + 1;
  const hunkNewStart = prefixLen - ctxBefore + 1;
  const hunkOldLen = ctxBefore + oldChanged.length + ctxAfter;
  const hunkNewLen = ctxBefore + newChanged.length + ctxAfter;

  lines.push(`@@ -${hunkOldStart},${hunkOldLen} +${hunkNewStart},${hunkNewLen} @@`);

  // Context before
  for (let i = prefixLen - ctxBefore; i < prefixLen; i++) {
    lines.push(` ${oldLines[i]}`);
  }

  // Removals
  for (const l of oldChanged) lines.push(`-${l}`);
  // Additions
  for (const l of newChanged) lines.push(`+${l}`);

  // Context after
  for (let i = oldLines.length - suffixLen; i < oldLines.length - suffixLen + ctxAfter; i++) {
    lines.push(` ${oldLines[i]}`);
  }

  return lines.join('\n');
}

/* ── Props ── */

interface ExpandedDiffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filePath: string;
  oldValue: string;
  newValue: string;
  icon?: ComponentType<{ className?: string }>;
  loading?: boolean;
  description?: string;
  files?: FileDiffSummary[];
  onFileSelect?: (filePath: string) => void;
  diffCache?: Map<string, string>;
  loadingDiffPath?: string | null;
  checkedFiles?: Set<string>;
  onToggleFile?: (path: string) => void;
  onRevertFile?: (path: string) => void;
  onIgnore?: (pattern: string) => void;
  basePath?: string;
  prReviewThreads?: PRReviewThread[];
  onRequestFullDiff?: (
    filePath: string,
  ) => Promise<{ oldValue: string; newValue: string; rawDiff?: string } | null>;
}

/** Props for the inline (non-dialog) expanded diff view */
export interface ExpandedDiffViewProps {
  filePath: string;
  oldValue: string;
  newValue: string;
  icon?: ComponentType<{ className?: string }>;
  loading?: boolean;
  rawDiff?: string;
  files?: FileDiffSummary[];
  onFileSelect?: (filePath: string) => void;
  diffCache?: Map<string, string>;
  onClose?: () => void;
  prReviewThreads?: PRReviewThread[];
  onResolveConflict?: (blockId: number, resolution: ConflictResolution) => void;
  onRequestFullDiff?: (
    filePath: string,
  ) => Promise<{ oldValue: string; newValue: string; rawDiff?: string } | null>;
  /** Enable line-level selection for partial staging */
  selectable?: boolean;
  /** Called with a constructed patch string when user clicks "Stage Selected Lines" */
  onStagePatch?: (patch: string) => void;
  /** Called with a constructed patch when user clicks "Unstage Selected Lines" */
  onUnstagePatch?: (patch: string) => void;
  /** Whether staging is in progress */
  stagingInProgress?: boolean;
  /** Reports selection state changes: 'all' | 'partial' | 'none' for the current file */
  onSelectionStateChange?: (filePath: string, state: 'all' | 'partial' | 'none') => void;
  /** Increment this counter to force re-select all lines (used when file checkbox is re-checked) */
  selectAllSignal?: number;
  /** Increment this counter to force deselect all lines (used when file checkbox is unchecked) */
  deselectAllSignal?: number;
}

/* ── Diff content ── */

function DiffContent({
  filePath,
  splitView,
  viewMode,
  loading,
  rawDiff,
  oldValue,
  newValue,
  showFullFile,
  wordWrap,
  searchQuery,
  searchCaseSensitive,
  currentMatchIndex,
  onMatchCount,
  onResolveConflict,
  selectable,
  selectedLines,
  onLineToggle,
  onHunkToggle,
  onDragSelect,
}: {
  filePath: string;
  /** @deprecated Use viewMode instead */
  splitView: boolean;
  viewMode?: DiffViewMode;
  loading: boolean;
  rawDiff?: string;
  oldValue: string;
  newValue: string;
  /** When true, disable code folding so the entire file is visible */
  showFullFile?: boolean;
  wordWrap?: boolean;
  searchQuery?: string;
  searchCaseSensitive?: boolean;
  currentMatchIndex?: number;
  onMatchCount?: (count: number) => void;
  onResolveConflict?: (blockId: number, resolution: ConflictResolution) => void;
  selectable?: boolean;
  selectedLines?: Set<number>;
  onLineToggle?: (lineIdx: number) => void;
  onHunkToggle?: (hunkLineIndices: number[]) => void;
  onDragSelect?: (startLineIdx: number, endLineIdx: number, select: boolean) => void;
}) {
  // Compute unified diff from old/new if rawDiff is not provided
  const unifiedDiff = useMemo(() => {
    if (rawDiff) return rawDiff;
    if (!oldValue && !newValue) return '';
    return computeUnifiedDiff(oldValue, newValue);
  }, [rawDiff, oldValue, newValue]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
        <Loader2 className="icon-base animate-spin" />
        Loading diff…
      </div>
    );
  }

  if (!unifiedDiff) {
    return <p className="p-4 text-xs text-muted-foreground">No diff available</p>;
  }

  return (
    <VirtualDiff
      unifiedDiff={unifiedDiff}
      viewMode={viewMode}
      splitView={splitView}
      filePath={filePath}
      codeFolding={!showFullFile}
      showMinimap={!!showFullFile}
      wordWrap={wordWrap}
      searchQuery={searchQuery}
      searchCaseSensitive={searchCaseSensitive}
      currentMatchIndex={currentMatchIndex}
      onMatchCount={onMatchCount}
      onResolveConflict={onResolveConflict}
      selectable={selectable}
      selectedLines={selectedLines}
      onLineToggle={onLineToggle}
      onHunkToggle={onHunkToggle}
      onDragSelect={onDragSelect}
      className="h-full"
      data-testid="expanded-diff-viewer"
    />
  );
}

/* ── Main component ── */

export function ExpandedDiffDialog({
  open,
  onOpenChange,
  filePath,
  oldValue,
  newValue,
  icon: Icon = FileCode,
  loading = false,
  description,
  files,
  onFileSelect,
  diffCache,
  checkedFiles,
  onToggleFile,
  onRevertFile,
  onIgnore,
  basePath,
  prReviewThreads,
  onRequestFullDiff,
}: ExpandedDiffDialogProps) {
  const [userViewMode, setUserViewMode] = useState<DiffViewMode>('three-pane');
  const [wordWrap, setWordWrap] = useState(false);
  const [showFullFile, setShowFullFile] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [fullDiffCache, setFullDiffCache] = useState<
    Map<string, { oldValue: string; newValue: string; rawDiff?: string }>
  >(new Map());
  const [loadingFullDiff, setLoadingFullDiff] = useState(false);

  // Force unified mode for fully added/deleted files (split/three-pane would show empty columns)
  const currentFileStatus = files?.find((f) => f.path === filePath)?.status;
  const isOneSided = currentFileStatus === 'deleted' || currentFileStatus === 'added';
  const viewMode: DiffViewMode = isOneSided ? 'unified' : userViewMode;

  // ── Search state ──
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [totalMatches, setTotalMatches] = useState(0);

  const handleViewModeChange = useCallback((value: string) => {
    if (!value) return;
    startTransition(() => setUserViewMode(value as DiffViewMode));
  }, []);

  const toggleFullFile = useCallback(async () => {
    if (showFullFile) {
      startTransition(() => setShowFullFile(false));
      return;
    }
    if (fullDiffCache.has(filePath)) {
      startTransition(() => setShowFullFile(true));
      return;
    }
    if (!onRequestFullDiff) {
      startTransition(() => setShowFullFile(true));
      return;
    }
    setLoadingFullDiff(true);
    const result = await onRequestFullDiff(filePath);
    setLoadingFullDiff(false);
    if (result) {
      setFullDiffCache((prev) => new Map(prev).set(filePath, result));
      startTransition(() => setShowFullFile(true));
    }
  }, [showFullFile, filePath, fullDiffCache, onRequestFullDiff]);

  // ── Search handlers ──
  const openSearch = useCallback(() => setShowSearch(true), []);
  const toggleSearch = useCallback(() => {
    setShowSearch((prev) => {
      if (prev) {
        setSearchQuery('');
        setCurrentMatchIndex(0);
        setTotalMatches(0);
      }
      return !prev;
    });
  }, []);

  const closeSearch = useCallback(() => {
    setShowSearch(false);
    setSearchQuery('');
    setCurrentMatchIndex(0);
    setTotalMatches(0);
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

  // Global Ctrl+F / Escape handler — uses window listener so it works
  // even when focus is on a nested element inside the dialog.
  // stopImmediatePropagation prevents other capture-phase listeners
  // (e.g. ThreadView search) from also firing.
  const onDialogKey = useEffectEvent((e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      e.stopImmediatePropagation();
      openSearch();
    } else if (e.key === 'Escape' && showSearch) {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeSearch();
    }
  });

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => onDialogKey(e);
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [open]);

  // Reset search when file changes
  useEffect(() => {
    setSearchQuery('');
    setCurrentMatchIndex(0);
    setTotalMatches(0);
  }, [filePath]);

  useEffect(() => {
    if (showFullFile && !fullDiffCache.has(filePath)) {
      setShowFullFile(false);
    }
  }, [filePath]); // eslint-disable-line react-hooks/exhaustive-deps

  const fileThreads = useMemo(
    () => (prReviewThreads ?? []).filter((t) => t.path === filePath),
    [prReviewThreads, filePath],
  );

  const hasFileSidebar = files && files.length > 0 && onFileSelect;

  // Determine which raw diff / old/new values to pass
  const effectiveRawDiff =
    showFullFile && fullDiffCache.has(filePath)
      ? fullDiffCache.get(filePath)!.rawDiff
      : diffCache?.get(filePath);
  const effectiveOldValue =
    showFullFile && fullDiffCache.has(filePath) ? fullDiffCache.get(filePath)!.oldValue : oldValue;
  const effectiveNewValue =
    showFullFile && fullDiffCache.has(filePath) ? fullDiffCache.get(filePath)!.newValue : newValue;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[85vh] w-[90vw] max-w-[90vw] flex-col gap-0 p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          if (showSearch) e.preventDefault();
        }}
      >
        <DialogHeader className="flex-shrink-0 select-none overflow-hidden border-b border-border px-4 py-3">
          <DialogTitle className="flex min-w-0 items-center gap-2 overflow-hidden font-mono text-sm">
            <Icon className="icon-base flex-shrink-0" />
            <span
              className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
              style={{ direction: 'rtl', textAlign: 'left' }}
            >
              {filePath}
            </span>
          </DialogTitle>
          <ToggleGroup
            type="single"
            size="sm"
            value={viewMode}
            onValueChange={handleViewModeChange}
            disabled={isPending || isOneSided}
            className="flex-shrink-0 gap-0 rounded-md border border-border"
            data-testid="diff-view-mode-group"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <ToggleGroupItem
                  value="unified"
                  className="rounded-none rounded-l-md border-0 px-1.5 data-[state=on]:bg-accent"
                  data-testid="diff-view-mode-unified"
                >
                  <RectangleVertical className="icon-base" />
                </ToggleGroupItem>
              </TooltipTrigger>
              <TooltipContent side="bottom">Unified</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <ToggleGroupItem
                  value="split"
                  className="rounded-none border-x border-border px-1.5 data-[state=on]:bg-accent"
                  data-testid="diff-view-mode-split"
                >
                  <Columns2 className="icon-base" />
                </ToggleGroupItem>
              </TooltipTrigger>
              <TooltipContent side="bottom">Split</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <ToggleGroupItem
                  value="three-pane"
                  className="rounded-none rounded-r-md border-0 px-1.5 data-[state=on]:bg-accent"
                  data-testid="diff-view-mode-three-pane"
                >
                  <Columns3 className="icon-base" />
                </ToggleGroupItem>
              </TooltipTrigger>
              <TooltipContent side="bottom">Three-pane</TooltipContent>
            </Tooltip>
          </ToggleGroup>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setWordWrap((w) => !w)}
                className={cn(
                  'flex-shrink-0 text-muted-foreground',
                  wordWrap && 'bg-accent text-accent-foreground',
                )}
                data-testid="diff-toggle-word-wrap"
              >
                <WrapText className="icon-base" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {wordWrap ? 'Word wrap on' : 'Word wrap off'}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={toggleFullFile}
                disabled={isPending || loadingFullDiff}
                className={cn(
                  'flex-shrink-0 text-muted-foreground',
                  showFullFile && 'bg-accent text-accent-foreground',
                )}
                data-testid="diff-toggle-full-file"
              >
                {isPending || loadingFullDiff ? (
                  <Loader2 className="icon-base animate-spin" />
                ) : (
                  <FileText className="icon-base" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {showFullFile ? 'Show changes only' : 'Show full file'}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={toggleSearch}
                className={cn(
                  'flex-shrink-0 text-muted-foreground',
                  showSearch && 'bg-accent text-accent-foreground',
                )}
                data-testid="diff-toggle-search"
              >
                <Search className="icon-base" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Search (Ctrl+F)</TooltipContent>
          </Tooltip>
          <DialogDescription className="sr-only">
            {description || `Diff for ${getFileName(filePath)}`}
          </DialogDescription>
        </DialogHeader>

        <div className="relative flex min-h-0 flex-1">
          {/* Search bar — positioned below header, above diff content */}
          {showSearch && (
            <SearchBar
              query={searchQuery}
              onQueryChange={(v) => {
                setSearchQuery(v);
                setCurrentMatchIndex(0);
              }}
              caseSensitive={searchCaseSensitive}
              onCaseSensitiveChange={(v) => {
                setSearchCaseSensitive(v);
                setCurrentMatchIndex(0);
              }}
              currentIndex={currentMatchIndex}
              totalMatches={totalMatches}
              onPrev={goToPrevMatch}
              onNext={goToNextMatch}
              onClose={closeSearch}
              placeholder="Search in diff..."
              showIcon={false}
              testIdPrefix="diff-search"
              className="absolute right-4 top-0 z-30 gap-1.5 rounded-b-lg border border-t-0 border-border bg-popover px-2 py-1.5 shadow-md"
            />
          )}
          {/* File tree sidebar */}
          {hasFileSidebar && (
            <div className="flex w-80 flex-shrink-0 flex-col border-r border-border">
              <div className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Files
              </div>
              <div className="min-h-0 flex-1">
                <FileTree
                  files={files}
                  selectedFile={filePath}
                  onFileClick={onFileSelect}
                  checkedFiles={checkedFiles}
                  onToggleFile={onToggleFile}
                  onRevertFile={onRevertFile}
                  onIgnore={onIgnore}
                  basePath={basePath}
                  fontSize="text-xs"
                  activeClass="bg-sidebar-accent text-sidebar-accent-foreground"
                  hoverClass="hover:bg-sidebar-accent/50 text-muted-foreground"
                  testIdPrefix="diff-sidebar"
                  virtualize
                />
              </div>
            </div>
          )}

          {/* Diff content + review threads */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="min-h-0 flex-1 overflow-auto">
              <DiffContent
                filePath={filePath}
                splitView={viewMode === 'split'}
                viewMode={viewMode}
                loading={loading || loadingFullDiff}
                rawDiff={effectiveRawDiff}
                oldValue={effectiveOldValue}
                newValue={effectiveNewValue}
                showFullFile={showFullFile}
                wordWrap={wordWrap}
                searchQuery={showSearch ? searchQuery : undefined}
                searchCaseSensitive={searchCaseSensitive}
                currentMatchIndex={currentMatchIndex}
                onMatchCount={handleMatchCount}
              />
            </div>
            {/* Inline PR review threads */}
            {fileThreads.length > 0 && (
              <div
                className="border-t border-border bg-muted/20 px-4 py-3"
                data-testid="diff-review-threads"
              >
                <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <MessageSquare className="size-3.5" />
                  {fileThreads.length} review {fileThreads.length === 1 ? 'thread' : 'threads'}
                </div>
                <div className="space-y-2">
                  {fileThreads.map((thread) => (
                    <DiffCommentThread
                      key={thread.id}
                      thread={thread}
                      className="w-full max-w-none"
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ── Inline expanded diff view (no dialog, no file tree) ── */

export function ExpandedDiffView({
  filePath,
  oldValue,
  newValue,
  icon: Icon = FileCode,
  loading = false,
  rawDiff,
  files,
  onFileSelect,
  diffCache,
  onClose,
  prReviewThreads,
  onResolveConflict,
  onRequestFullDiff,
  selectable = false,
  onStagePatch,
  onUnstagePatch,
  stagingInProgress = false,
  onSelectionStateChange,
  selectAllSignal = 0,
  deselectAllSignal = 0,
}: ExpandedDiffViewProps) {
  const [userViewMode, setUserViewMode] = useState<DiffViewMode>('three-pane');
  const [wordWrap, setWordWrap] = useState(false);
  const [showFullFile, setShowFullFile] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [fullDiffCache, setFullDiffCache] = useState<
    Map<string, { oldValue: string; newValue: string; rawDiff?: string }>
  >(new Map());
  const [loadingFullDiff, setLoadingFullDiff] = useState(false);

  const currentFileStatus = files?.find((f) => f.path === filePath)?.status;
  const currentFileStaged = files?.find((f) => f.path === filePath)?.staged ?? false;
  const isOneSided = currentFileStatus === 'deleted' || currentFileStatus === 'added';
  // Force unified view only when the file is fully added/deleted (one-sided)
  const viewMode: DiffViewMode = isOneSided ? 'unified' : userViewMode;

  // ── Line selection state ──
  const [selectedLines, setSelectedLines] = useState<Set<number>>(new Set());

  // Parse the effective diff for selection purposes
  const effectiveDiffForSelection = rawDiff ?? diffCache?.get(filePath);
  const parsedDiff = useMemo(() => {
    if (!selectable || !effectiveDiffForSelection) return null;
    return parseRawDiff(effectiveDiffForSelection);
  }, [selectable, effectiveDiffForSelection]);

  const allChangeableIndices = useMemo(() => {
    if (!parsedDiff) return new Set<number>();
    return getChangeableIndices(parsedDiff);
  }, [parsedDiff]);

  // Initialize selection with all changeable lines selected when file changes
  useEffect(() => {
    if (selectable && allChangeableIndices.size > 0) {
      setSelectedLines(new Set(allChangeableIndices));
    } else {
      setSelectedLines(new Set());
    }
  }, [filePath, selectable, allChangeableIndices]);

  // Track previous signal values so effects only fire on actual changes, not on mount
  const prevSelectSignal = useRef(selectAllSignal);
  const prevDeselectSignal = useRef(deselectAllSignal);

  // Re-select all lines when parent signals (e.g. file checkbox re-checked)
  useEffect(() => {
    if (selectAllSignal === prevSelectSignal.current) return;
    prevSelectSignal.current = selectAllSignal;
    if (selectable && allChangeableIndices.size > 0) {
      setSelectedLines(new Set(allChangeableIndices));
    }
  }, [selectAllSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  // Deselect all lines when parent signals (e.g. file checkbox unchecked)
  useEffect(() => {
    if (deselectAllSignal === prevDeselectSignal.current) return;
    prevDeselectSignal.current = deselectAllSignal;
    if (selectable) {
      setSelectedLines(new Set());
    }
  }, [deselectAllSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLineToggle = useCallback((lineIdx: number) => {
    setSelectedLines((prev) => {
      const next = new Set(prev);
      if (next.has(lineIdx)) {
        next.delete(lineIdx);
      } else {
        next.add(lineIdx);
      }
      return next;
    });
  }, []);

  // Snapshot of selectedLines at drag start — used to revert lines outside the drag range
  const dragSnapshotRef = useRef<Set<number> | null>(null);

  const handleDragSelect = useCallback(
    (startLineIdx: number, endLineIdx: number, select: boolean) => {
      // Save snapshot on first call of a drag (when snapshot is null)
      if (!dragSnapshotRef.current) {
        dragSnapshotRef.current = new Set(selectedLines);
      }
      const snapshot = dragSnapshotRef.current;
      const lo = Math.min(startLineIdx, endLineIdx);
      const hi = Math.max(startLineIdx, endLineIdx);

      // Find changeable indices in the drag range
      const inRange = new Set<number>();
      for (const idx of allChangeableIndices) {
        if (idx >= lo && idx <= hi) inRange.add(idx);
      }

      // Start from snapshot, apply mode only to lines in range
      const next = new Set(snapshot);
      for (const idx of inRange) {
        if (select) {
          next.add(idx);
        } else {
          next.delete(idx);
        }
      }
      setSelectedLines(next);
    },
    [allChangeableIndices, selectedLines],
  );

  // Clear drag snapshot on mouseup
  useEffect(() => {
    const handler = () => {
      dragSnapshotRef.current = null;
    };
    window.addEventListener('mouseup', handler);
    return () => window.removeEventListener('mouseup', handler);
  }, []);

  const handleHunkToggle = useCallback((hunkLineIndices: number[]) => {
    setSelectedLines((prev) => {
      const next = new Set(prev);
      const allSelected = hunkLineIndices.every((idx) => next.has(idx));
      if (allSelected) {
        for (const idx of hunkLineIndices) next.delete(idx);
      } else {
        for (const idx of hunkLineIndices) next.add(idx);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedLines(new Set(allChangeableIndices));
  }, [allChangeableIndices]);

  const handleSelectNone = useCallback(() => {
    setSelectedLines(new Set());
  }, []);

  const handleStageSelected = useCallback(() => {
    if (!parsedDiff || !onStagePatch) return;
    const patch = buildPatchFromSelection(parsedDiff, selectedLines);
    if (patch) onStagePatch(patch);
  }, [parsedDiff, selectedLines, onStagePatch]);

  const selectedCount = selectable ? selectedLines.size : 0;
  const totalChangeable = selectable ? allChangeableIndices.size : 0;

  // Report selection state to parent (for file-level indeterminate checkbox)
  useEffect(() => {
    if (!selectable || !onSelectionStateChange) return;
    const state =
      selectedCount === 0 ? 'none' : selectedCount === totalChangeable ? 'all' : 'partial';
    onSelectionStateChange(filePath, state);
  }, [selectable, filePath, selectedCount, totalChangeable, onSelectionStateChange]);

  // ── Search state ──
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [totalMatches, setTotalMatches] = useState(0);

  const handleViewModeChange = useCallback((value: string) => {
    if (!value) return;
    startTransition(() => setUserViewMode(value as DiffViewMode));
  }, []);

  const toggleFullFile = useCallback(async () => {
    if (showFullFile) {
      startTransition(() => setShowFullFile(false));
      return;
    }
    if (fullDiffCache.has(filePath)) {
      startTransition(() => setShowFullFile(true));
      return;
    }
    if (!onRequestFullDiff) {
      startTransition(() => setShowFullFile(true));
      return;
    }
    setLoadingFullDiff(true);
    const result = await onRequestFullDiff(filePath);
    setLoadingFullDiff(false);
    if (result) {
      setFullDiffCache((prev) => new Map(prev).set(filePath, result));
      startTransition(() => setShowFullFile(true));
    }
  }, [showFullFile, filePath, fullDiffCache, onRequestFullDiff]);

  // ── Search handlers ──
  const openSearch = useCallback(() => setShowSearch(true), []);
  const toggleSearch = useCallback(() => {
    setShowSearch((prev) => {
      if (prev) {
        setSearchQuery('');
        setCurrentMatchIndex(0);
        setTotalMatches(0);
      }
      return !prev;
    });
  }, []);

  const closeSearch = useCallback(() => {
    setShowSearch(false);
    setSearchQuery('');
    setCurrentMatchIndex(0);
    setTotalMatches(0);
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

  // Global Ctrl+F / Escape handler — uses window listener so it works
  // even when the overlay (rendered via portal) doesn't have focus.
  // stopImmediatePropagation prevents other capture-phase listeners
  // (e.g. ThreadView search) from also firing.
  const onOuterKey = useEffectEvent((e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      e.stopImmediatePropagation();
      openSearch();
    } else if (e.key === 'Escape') {
      if (showSearch) {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeSearch();
      } else if (onClose) {
        onClose();
      }
    }
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => onOuterKey(e);
    // Use capture phase to intercept before other handlers
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  // Reset search when file changes
  useEffect(() => {
    setSearchQuery('');
    setCurrentMatchIndex(0);
    setTotalMatches(0);
  }, [filePath]);

  useEffect(() => {
    if (showFullFile && !fullDiffCache.has(filePath)) {
      setShowFullFile(false);
    }
  }, [filePath]); // eslint-disable-line react-hooks/exhaustive-deps

  const fileThreads = useMemo(
    () => (prReviewThreads ?? []).filter((t) => t.path === filePath),
    [prReviewThreads, filePath],
  );

  // Determine which raw diff / old/new values to pass
  const effectiveRawDiff =
    showFullFile && fullDiffCache.has(filePath)
      ? fullDiffCache.get(filePath)!.rawDiff
      : (rawDiff ?? diffCache?.get(filePath));
  const effectiveOldValue =
    showFullFile && fullDiffCache.has(filePath) ? fullDiffCache.get(filePath)!.oldValue : oldValue;
  const effectiveNewValue =
    showFullFile && fullDiffCache.has(filePath) ? fullDiffCache.get(filePath)!.newValue : newValue;

  return (
    <div className="flex h-full flex-col bg-background" data-testid="expanded-diff-view">
      {/* Header toolbar */}
      <div className="flex h-12 flex-shrink-0 select-none items-center gap-2 border-b border-border px-4">
        <Icon className="icon-base flex-shrink-0 text-muted-foreground" />
        <span
          className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-foreground"
          style={{ direction: 'rtl', textAlign: 'left' }}
        >
          {filePath}
        </span>
        <ToggleGroup
          type="single"
          size="sm"
          value={viewMode}
          onValueChange={handleViewModeChange}
          disabled={isPending || isOneSided}
          className="flex-shrink-0 gap-0 rounded-md border border-border"
          data-testid="diff-view-view-mode-group"
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <ToggleGroupItem
                value="unified"
                className="rounded-none rounded-l-md border-0 px-1.5 data-[state=on]:bg-accent"
                data-testid="diff-view-view-mode-unified"
              >
                <RectangleVertical className="icon-base" />
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent side="bottom">Unified</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <ToggleGroupItem
                value="split"
                className="rounded-none border-x border-border px-1.5 data-[state=on]:bg-accent"
                data-testid="diff-view-view-mode-split"
              >
                <Columns2 className="icon-base" />
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent side="bottom">Split</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <ToggleGroupItem
                value="three-pane"
                className="rounded-none rounded-r-md border-0 px-1.5 data-[state=on]:bg-accent"
                data-testid="diff-view-view-mode-three-pane"
              >
                <Columns3 className="icon-base" />
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent side="bottom">Three-pane</TooltipContent>
          </Tooltip>
        </ToggleGroup>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setWordWrap((w) => !w)}
              className={cn(
                'flex-shrink-0 text-muted-foreground',
                wordWrap && 'bg-accent text-accent-foreground',
              )}
              data-testid="diff-view-toggle-word-wrap"
            >
              <WrapText className="icon-base" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {wordWrap ? 'Word wrap on' : 'Word wrap off'}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleFullFile}
              disabled={isPending || loadingFullDiff}
              className={cn(
                'flex-shrink-0 text-muted-foreground',
                showFullFile && 'bg-accent text-accent-foreground',
              )}
              data-testid="diff-view-toggle-full-file"
            >
              {isPending || loadingFullDiff ? (
                <Loader2 className="icon-base animate-spin" />
              ) : (
                <FileText className="icon-base" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {showFullFile ? 'Show changes only' : 'Show full file'}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleSearch}
              className={cn(
                'flex-shrink-0 text-muted-foreground',
                showSearch && 'bg-accent text-accent-foreground',
              )}
              data-testid="diff-view-toggle-search"
            >
              <Search className="icon-base" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Search (Ctrl+F)</TooltipContent>
        </Tooltip>
        {onClose && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            className="flex-shrink-0 text-muted-foreground"
            data-testid="expanded-diff-close"
          >
            <X className="icon-base" />
          </Button>
        )}
      </div>

      {/* Diff content + review threads */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Search bar — positioned below header, above diff content */}
        {showSearch && (
          <SearchBar
            query={searchQuery}
            onQueryChange={(v) => {
              setSearchQuery(v);
              setCurrentMatchIndex(0);
            }}
            caseSensitive={searchCaseSensitive}
            onCaseSensitiveChange={(v) => {
              setSearchCaseSensitive(v);
              setCurrentMatchIndex(0);
            }}
            currentIndex={currentMatchIndex}
            totalMatches={totalMatches}
            onPrev={goToPrevMatch}
            onNext={goToNextMatch}
            onClose={closeSearch}
            placeholder="Search in diff..."
            showIcon={false}
            testIdPrefix="diff-view-search"
            className="absolute right-4 top-0 z-30 gap-1.5 rounded-b-lg border border-t-0 border-border bg-popover px-2 py-1.5 shadow-md"
          />
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          <DiffContent
            filePath={filePath}
            splitView={viewMode === 'split'}
            viewMode={viewMode}
            loading={loading || loadingFullDiff}
            rawDiff={effectiveRawDiff}
            oldValue={effectiveOldValue}
            newValue={effectiveNewValue}
            showFullFile={showFullFile}
            wordWrap={wordWrap}
            searchQuery={showSearch ? searchQuery : undefined}
            searchCaseSensitive={searchCaseSensitive}
            currentMatchIndex={currentMatchIndex}
            onMatchCount={handleMatchCount}
            onResolveConflict={onResolveConflict}
            selectable={selectable && viewMode === 'unified'}
            selectedLines={selectable && viewMode === 'unified' ? selectedLines : undefined}
            onLineToggle={selectable && viewMode === 'unified' ? handleLineToggle : undefined}
            onHunkToggle={selectable && viewMode === 'unified' ? handleHunkToggle : undefined}
            onDragSelect={selectable && viewMode === 'unified' ? handleDragSelect : undefined}
          />
        </div>
        {fileThreads.length > 0 && (
          <div
            className="border-t border-border bg-muted/20 px-4 py-3"
            data-testid="diff-view-review-threads"
          >
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <MessageSquare className="size-3.5" />
              {fileThreads.length} review {fileThreads.length === 1 ? 'thread' : 'threads'}
            </div>
            <div className="space-y-2">
              {fileThreads.map((thread) => (
                <DiffCommentThread key={thread.id} thread={thread} className="w-full max-w-none" />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
