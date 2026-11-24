import { useVirtualizer } from '@tanstack/react-virtual';
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  buildConflictStartLines,
  buildDiffRows,
  buildHunkLineMap,
  buildRenderRows,
  computeRowHeightMap,
  computeSearchMatchData,
  measureMaxContentWidth,
} from '@/components/virtual-diff/diff-rows';
import { DiffMinimap } from '@/components/virtual-diff/DiffMinimap';
import { DiffScrollBody } from '@/components/virtual-diff/DiffScrollBody';
import { useDiffDragSelect } from '@/components/virtual-diff/use-diff-drag-select';
import {
  usePaneSelectionIsolation,
  useWordWrapMeasure,
} from '@/components/virtual-diff/use-diff-environment';
import { useHorizontalScroll } from '@/components/virtual-diff/use-horizontal-scroll';
import { useStickyHunk } from '@/components/virtual-diff/use-sticky-hunk';
import { ensureHighlight, filePathToHljsLang, HIGHLIGHT_MAX_LINES } from '@/hooks/use-highlight';
import { isPretextReady, makeMonoFont } from '@/hooks/use-pretext';
import { highlightCache } from '@/lib/diff/highlight';
import { buildSections } from '@/lib/diff/layout';
import { parseUnifiedDiff } from '@/lib/diff/parse';
import type { DiffViewMode, VirtualDiffProps } from '@/lib/diff/types';
import { cn } from '@/lib/utils';
import { useSettingsStore, DIFF_FONT_SIZE_PX, DIFF_ROW_HEIGHT_PX } from '@/stores/settings-store';

export type { DiffViewMode, ConflictResolution, VirtualDiffProps } from '@/lib/diff/types';

/* ── Main component ── */

export const VirtualDiff = memo(function VirtualDiff({
  unifiedDiff,
  splitView = false,
  viewMode: viewModeProp,
  filePath,
  codeFolding = true,
  contextLines = 3,
  showMinimap = false,
  wordWrap = false,
  searchQuery,
  searchCaseSensitive = false,
  currentMatchIndex = -1,
  onMatchCount,
  onResolveConflict,
  selectable = false,
  selectedLines,
  onLineToggle,
  onHunkToggle,
  onDragSelect,
  className,
  ...props
}: VirtualDiffProps) {
  const viewMode: DiffViewMode = viewModeProp ?? (splitView ? 'split' : 'unified');
  const fontSize = useSettingsStore((s) => s.fontSize);
  const rowHeight = DIFF_ROW_HEIGHT_PX[fontSize];
  const diffFontPx = DIFF_FONT_SIZE_PX[fontSize];
  const monoFont = useMemo(() => makeMonoFont(diffFontPx), [diffFontPx]);
  const monoLineHeight = rowHeight;
  const scrollAreaId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const hScrollBarRef = useRef<HTMLDivElement>(null);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const scrollCallbackRef = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    setScrollElement(node);
  }, []);
  const [langReady, setLangReady] = useState(false);
  const [collapsedState, setCollapsedState] = useState<Map<number, boolean>>(new Map());

  const parsed = useMemo(() => parseUnifiedDiff(unifiedDiff), [unifiedDiff]);

  const lang = useMemo(() => (filePath ? filePathToHljsLang(filePath) : 'plaintext'), [filePath]);

  useEffect(() => {
    if (parsed.lines.length > HIGHLIGHT_MAX_LINES) {
      setLangReady(true);
      return;
    }
    let cancelled = false;
    setLangReady(false);
    ensureHighlight(parsed.lines.map((line) => line.text).join('\n'), lang).then(() => {
      if (!cancelled) {
        highlightCache.clear();
        setLangReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [lang, parsed]);

  const { pretextReady, diffContainerWidth } = useWordWrapMeasure(
    wordWrap,
    scrollRef,
    parsed.lines,
    monoFont,
  );
  usePaneSelectionIsolation(viewMode, scrollRef);

  const sections = useMemo(
    () => (codeFolding ? buildSections(parsed.lines, contextLines) : []),
    [parsed.lines, codeFolding, contextLines],
  );

  const effectiveSections = useMemo(() => {
    if (!codeFolding) return sections;
    return sections.map((s, i) => ({
      ...s,
      collapsed: collapsedState.has(i) ? collapsedState.get(i)! : s.collapsed,
    }));
  }, [sections, collapsedState, codeFolding]);

  // Build a map from hunk header line-index → all add/del line indices in that hunk
  // Used for hunk-level checkbox toggling
  const hunkLineMap = useMemo(() => {
    if (!selectable) return new Map<number, number[]>();
    return buildHunkLineMap(parsed.hunkHeaders, parsed.lines);
  }, [selectable, parsed.hunkHeaders, parsed.lines]);

  // Build a set of line indices where conflict action bars should be injected (before the marker-start line)
  const conflictStartLines = useMemo(
    () => buildConflictStartLines(parsed.conflictBlocks),
    [parsed.conflictBlocks],
  );

  // Build intermediate VirtualRow list
  const rows = useMemo(
    () =>
      buildDiffRows({
        codeFolding,
        effectiveSections,
        lines: parsed.lines,
        hunkHeaders: parsed.hunkHeaders,
        contextLines,
        conflictStartLines,
      }),
    [
      codeFolding,
      effectiveSections,
      parsed.lines,
      parsed.hunkHeaders,
      contextLines,
      conflictStartLines,
    ],
  );

  // Build final render rows (handles split/three-pane pairing)
  const renderRows = useMemo(
    () => buildRenderRows(viewMode, rows, parsed.lines),
    [viewMode, rows, parsed.lines],
  );

  // ── Search match computation ──
  const searchMatchData = useMemo(() => {
    if (!searchQuery) return null;
    return computeSearchMatchData(renderRows, searchQuery, searchCaseSensitive);
  }, [renderRows, searchQuery, searchCaseSensitive]);

  // Report match count to parent
  useEffect(() => {
    onMatchCount?.(searchMatchData?.total ?? 0);
  }, [searchMatchData?.total, onMatchCount]);

  // ── Per-row height map for word-wrap mode ──
  const rowHeightMap = useMemo(() => {
    if (!wordWrap || !pretextReady || diffContainerWidth <= 0 || !isPretextReady()) return null;
    return computeRowHeightMap({
      diffContainerWidth,
      viewMode,
      renderRows,
      monoFont,
      monoLineHeight,
    });
  }, [wordWrap, pretextReady, diffContainerWidth, viewMode, renderRows, monoFont, monoLineHeight]);

  const toggleFold = useCallback(
    (sectionIdx: number) => {
      setCollapsedState((prev) => {
        const next = new Map(prev);
        const isCollapsed = next.has(sectionIdx)
          ? next.get(sectionIdx)!
          : sections[sectionIdx].collapsed;
        next.set(sectionIdx, !isCollapsed);
        return next;
      });
    },
    [sections],
  );

  const virtualizer = useVirtualizer({
    count: renderRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rowHeightMap ? (rowHeightMap.get(index) ?? rowHeight) : rowHeight),
    overscan: 30,
    // Re-render on scroll through React's scheduler, not a blocking flushSync.
    useFlushSync: false,
  });

  // Re-measure all rows when word-wrap is toggled off or font size changes
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [wordWrap, viewMode, rowHeight, virtualizer]);

  // Scroll to the row containing the current match
  useEffect(() => {
    if (!searchMatchData || currentMatchIndex < 0 || currentMatchIndex >= searchMatchData.total)
      return;
    const rowIdx = searchMatchData.matchToRow[currentMatchIndex];
    if (rowIdx !== undefined) {
      virtualizer.scrollToIndex(rowIdx, { align: 'center' });
    }
  }, [currentMatchIndex, searchMatchData, virtualizer]);

  // Measure actual max content width using a canvas for accurate monospace measurement.
  // Used by split/three-pane for the custom horizontal scrollbar AND by unified mode
  // to set an explicit container width so row backgrounds extend on horizontal scroll.
  const needsHScroll = !wordWrap && viewMode !== 'unified';
  const maxContentWidth = useMemo(() => {
    if (wordWrap) return 0;
    return measureMaxContentWidth(parsed.lines, viewMode, diffFontPx);
  }, [wordWrap, parsed.lines, viewMode, diffFontPx]);

  // Single horizontal scrollbar for split/three-pane (only when not wrapping)
  const hSpacerWidth = useHorizontalScroll(scrollRef, hScrollBarRef, needsHScroll, maxContentWidth);
  const totalSize = virtualizer.getTotalSize();

  const effectiveLang = langReady ? lang : 'plaintext';
  const tooManyLines = parsed.lines.length > HIGHLIGHT_MAX_LINES;
  const highlightLang = tooManyLines ? 'plaintext' : effectiveLang;
  const hasLines = parsed.lines.length > 0;

  // ── Drag-select (GitHub Desktop-style click+drag on checkboxes) ──
  const drag = useDiffDragSelect({
    selectable,
    selectedLines,
    onDragSelect,
  });

  // ── Sticky hunk header ──
  const stickyHunk = useStickyHunk(renderRows, scrollRef, virtualizer, rowHeight);

  const gutterWidth = viewMode !== 'unified' ? 'w-[54px]' : 'w-[88px]';

  const diffContent = (
    <DiffScrollBody
      showMinimap={showMinimap}
      className={className}
      testId={props['data-testid']}
      scrollAreaId={scrollAreaId}
      scrollCallbackRef={scrollCallbackRef}
      hScrollBarRef={hScrollBarRef}
      hSpacerWidth={hSpacerWidth}
      needsHScroll={needsHScroll}
      drag={drag}
      stickyHunk={stickyHunk}
      virtualizer={virtualizer}
      renderRows={renderRows}
      rowHeightMap={rowHeightMap}
      totalSize={totalSize}
      maxContentWidth={maxContentWidth}
      matchOffsets={searchMatchData?.prefixSum}
      rowContent={{
        rowHeight,
        selectable,
        hunkLineMap,
        selectedLines,
        onHunkToggle,
        onLineToggle,
        onResolveConflict,
        gutterWidth,
        toggleFold,
        highlightLang,
        wordWrap,
        searchQuery,
        searchCaseSensitive,
        currentMatchIndex,
      }}
    />
  );

  if (!hasLines) {
    return (
      <p className="text-muted-foreground p-4 text-xs" data-testid={props['data-testid']}>
        No diff available
      </p>
    );
  }

  if (!showMinimap) return diffContent;

  return (
    <div className={cn('flex', className)}>
      {diffContent}
      <DiffMinimap
        lines={parsed.lines}
        scrollElement={scrollElement}
        scrollAreaId={scrollAreaId}
        totalSize={totalSize}
      />
    </div>
  );
});
