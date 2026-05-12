import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { TriCheckbox } from '@/components/ui/tri-checkbox';
import { ConflictActionBar } from '@/components/virtual-diff/ConflictActionBar';
import { DiffMinimap } from '@/components/virtual-diff/DiffMinimap';
import { SplitRow } from '@/components/virtual-diff/SplitRow';
import { ThreePaneRow } from '@/components/virtual-diff/ThreePaneRow';
import { UnifiedRow } from '@/components/virtual-diff/UnifiedRow';
import { useHorizontalScroll } from '@/components/virtual-diff/use-horizontal-scroll';
import { ensureLanguage, filePathToHljsLang, HIGHLIGHT_MAX_LINES } from '@/hooks/use-highlight';
import {
  getCachedPrepared,
  isPretextReady,
  layoutSync,
  prepareBatch,
  ensurePretextLoaded,
  makeMonoFont,
} from '@/hooks/use-pretext';
import { countTextMatches } from '@/lib/diff/highlight';
import {
  buildSections,
  buildSplitPairs,
  buildThreePaneTriples,
  buildVirtualRows,
} from '@/lib/diff/layout';
import { parseUnifiedDiff } from '@/lib/diff/parse';
import type {
  ConflictBlock,
  DiffSection,
  DiffViewMode,
  RenderRow,
  VirtualDiffProps,
  VirtualRow,
} from '@/lib/diff/types';
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const hScrollBarRef = useRef<HTMLDivElement>(null);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const scrollCallbackRef = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    setScrollElement(node);
  }, []);
  const [langReady, setLangReady] = useState(false);
  const [collapsedState, setCollapsedState] = useState<Map<number, boolean>>(new Map());
  const [pretextReady, setPretextReady] = useState(false);
  const [diffContainerWidth, setDiffContainerWidth] = useState(0);

  const parsed = useMemo(() => parseUnifiedDiff(unifiedDiff), [unifiedDiff]);

  const lang = useMemo(() => (filePath ? filePathToHljsLang(filePath) : 'plaintext'), [filePath]);

  useEffect(() => {
    if (lang === 'plaintext' || lang === 'text') {
      setLangReady(true);
      return;
    }
    let cancelled = false;
    ensureLanguage(lang).then(() => {
      if (!cancelled) setLangReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [lang]);

  // ── Container width tracking for pretext word-wrap measurement ──
  useEffect(() => {
    if (!wordWrap) return;
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setDiffContainerWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    setDiffContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [wordWrap]);

  // ── Pretext warm-up: prepare all diff line texts for word-wrap measurement ──
  useEffect(() => {
    if (!wordWrap) return;
    let cancelled = false;
    ensurePretextLoaded().then(() => {
      if (cancelled) return;
      const toPrepare = parsed.lines
        .map((l) => l.text)
        .filter((t) => t.length > 0 && !getCachedPrepared(t, monoFont));
      // Deduplicate
      const unique = [...new Set(toPrepare)];
      if (unique.length > 0) {
        prepareBatch(unique, monoFont).then(() => {
          if (!cancelled) setPretextReady(true);
        });
      } else {
        setPretextReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [wordWrap, parsed.lines, monoFont]);

  // ── Pane selection isolation: constrain text selection to a single pane ──
  useEffect(() => {
    if (viewMode === 'unified') return;
    const container = scrollRef.current;
    if (!container) return;

    let disabled: HTMLElement[] = [];

    const restore = () => {
      for (const p of disabled) p.style.userSelect = '';
      disabled = [];
    };

    const onMouseDown = (e: MouseEvent) => {
      // Clear the browser selection before restoring panes so the old
      // highlight doesn't flash across all columns.
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) sel.removeAllRanges();

      // Restore previous isolation
      restore();

      const target = e.target as HTMLElement;
      const pane = target.closest('[data-pane]') as HTMLElement | null;
      if (!pane) return;

      // Disable all panes that don't match the clicked one
      const activePaneName = pane.dataset.pane;
      container.querySelectorAll<HTMLElement>('[data-pane]').forEach((p) => {
        if (p.dataset.pane !== activePaneName) {
          p.style.userSelect = 'none';
          disabled.push(p);
        }
      });
    };

    // Clicking outside the diff container restores all panes
    const onDocMouseDown = (e: MouseEvent) => {
      if (!container.contains(e.target as Node)) restore();
    };

    container.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousedown', onDocMouseDown);
    return () => {
      container.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mousedown', onDocMouseDown);
      restore();
    };
  }, [viewMode]);

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
    const map = new Map<number, number[]>();
    const sortedHeaders = Array.from(parsed.hunkHeaders.keys()).toSorted((a, b) => a - b);
    for (let h = 0; h < sortedHeaders.length; h++) {
      const start = sortedHeaders[h];
      const end = h + 1 < sortedHeaders.length ? sortedHeaders[h + 1] : parsed.lines.length;
      const changeIndices: number[] = [];
      for (let i = start; i < end; i++) {
        const line = parsed.lines[i];
        if (line && (line.type === 'add' || line.type === 'del')) {
          changeIndices.push(i);
        }
      }
      map.set(start, changeIndices);
    }
    return map;
  }, [selectable, parsed.hunkHeaders, parsed.lines]);

  // Build a set of line indices where conflict action bars should be injected (before the marker-start line)
  const conflictStartLines = useMemo(() => {
    const s = new Map<number, ConflictBlock>();
    for (const block of parsed.conflictBlocks) {
      s.set(block.startLineIdx, block);
    }
    return s;
  }, [parsed.conflictBlocks]);

  // Build intermediate VirtualRow list
  const rows = useMemo((): VirtualRow[] => {
    if (!codeFolding) {
      const r: VirtualRow[] = [];
      const sortedHunks = Array.from(parsed.hunkHeaders.entries()).toSorted((a, b) => a[0] - b[0]);
      let nextHunkI = 0;
      for (let i = 0; i < parsed.lines.length; i++) {
        if (nextHunkI < sortedHunks.length && sortedHunks[nextHunkI][0] === i) {
          r.push({
            type: 'hunk',
            text: sortedHunks[nextHunkI][1],
            hunkStartIdx: sortedHunks[nextHunkI][0],
          });
          nextHunkI++;
        }
        // Inject conflict action bar before the marker-start line
        const block = conflictStartLines.get(i);
        if (block) {
          r.push({ type: 'conflict-actions', block });
        }
        r.push({ type: 'line', lineIdx: i });
      }
      return r;
    }
    const base = buildVirtualRows(
      effectiveSections,
      parsed.lines,
      parsed.hunkHeaders,
      contextLines,
    );
    // Inject conflict action bars
    if (conflictStartLines.size > 0) {
      const result: VirtualRow[] = [];
      for (const row of base) {
        if (row.type === 'line') {
          const block = conflictStartLines.get(row.lineIdx);
          if (block) {
            result.push({ type: 'conflict-actions', block });
          }
        }
        result.push(row);
      }
      return result;
    }
    return base;
  }, [
    codeFolding,
    effectiveSections,
    parsed.lines,
    parsed.hunkHeaders,
    contextLines,
    conflictStartLines,
  ]);

  // Build final render rows (handles split/three-pane pairing)
  const renderRows = useMemo((): RenderRow[] => {
    if (viewMode === 'split' || viewMode === 'three-pane') {
      const result: RenderRow[] = [];
      let i = 0;
      while (i < rows.length) {
        const row = rows[i];
        if (row.type === 'hunk') {
          result.push({ type: 'hunk', text: row.text, hunkStartIdx: row.hunkStartIdx });
          i++;
        } else if (row.type === 'fold') {
          result.push(row);
          i++;
        } else if (row.type === 'conflict-actions') {
          result.push(row);
          i++;
        } else {
          // Collect consecutive line rows
          const lineStart = row.lineIdx;
          let lineEnd = row.lineIdx;
          let j = i + 1;
          while (j < rows.length && rows[j].type === 'line') {
            lineEnd = (rows[j] as { type: 'line'; lineIdx: number }).lineIdx;
            j++;
          }
          if (viewMode === 'three-pane') {
            for (const triple of buildThreePaneTriples(parsed.lines, lineStart, lineEnd)) {
              result.push({ type: 'three-pane-triple', triple });
            }
          } else {
            for (const pair of buildSplitPairs(parsed.lines, lineStart, lineEnd)) {
              result.push({ type: 'split-pair', pair });
            }
          }
          i = j;
        }
      }
      return result;
    }

    return rows.map((row): RenderRow => {
      if (row.type === 'hunk')
        return { type: 'hunk', text: row.text, hunkStartIdx: row.hunkStartIdx };
      if (row.type === 'fold') return row;
      if (row.type === 'conflict-actions') return row;
      return { type: 'unified-line', line: parsed.lines[row.lineIdx], lineIdx: row.lineIdx };
    });
  }, [viewMode, rows, parsed.lines]);

  // ── Search match computation ──
  // For each renderRow, count matches in all panes' text (left + right / left + center + right).
  // Builds a prefix-sum so we can map globalMatchIndex → rowIndex and compute per-row offsets.
  const searchMatchData = useMemo(() => {
    if (!searchQuery) return null;
    const q = searchQuery;
    const perRow: number[] = [];

    for (const row of renderRows) {
      let count = 0;
      if (row.type === 'unified-line') {
        count = countTextMatches(row.line.text, q, searchCaseSensitive);
      } else if (row.type === 'split-pair') {
        if (row.pair.left) count += countTextMatches(row.pair.left.text, q, searchCaseSensitive);
        if (row.pair.right) count += countTextMatches(row.pair.right.text, q, searchCaseSensitive);
      } else if (row.type === 'three-pane-triple') {
        if (row.triple.left)
          count += countTextMatches(row.triple.left.text, q, searchCaseSensitive);
        if (row.triple.center)
          count += countTextMatches(row.triple.center.text, q, searchCaseSensitive);
        if (row.triple.right)
          count += countTextMatches(row.triple.right.text, q, searchCaseSensitive);
      }
      perRow.push(count);
    }

    // Prefix sums: prefixSum[i] = total matches in rows 0..i-1
    const prefixSum: number[] = [0];
    for (let i = 0; i < perRow.length; i++) {
      prefixSum.push(prefixSum[i] + perRow[i]);
    }
    const total = prefixSum[prefixSum.length - 1];

    // Map globalMatchIndex → rowIndex
    const matchToRow: number[] = [];
    for (let i = 0; i < perRow.length; i++) {
      for (let j = 0; j < perRow[i]; j++) matchToRow.push(i);
    }

    return { perRow, prefixSum, total, matchToRow };
  }, [renderRows, searchQuery, searchCaseSensitive]);

  // Report match count to parent
  useEffect(() => {
    onMatchCount?.(searchMatchData?.total ?? 0);
  }, [searchMatchData?.total, onMatchCount]);

  // Scroll to the row containing the current match
  useEffect(() => {
    if (!searchMatchData || currentMatchIndex < 0 || currentMatchIndex >= searchMatchData.total)
      return;
    const rowIdx = searchMatchData.matchToRow[currentMatchIndex];
    if (rowIdx !== undefined) {
      virtualizer.scrollToIndex(rowIdx, { align: 'center' });
    }
  }, [currentMatchIndex, searchMatchData]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Per-row height map for word-wrap mode ──
  const rowHeightMap = useMemo(() => {
    if (!wordWrap || !pretextReady || diffContainerWidth <= 0 || !isPretextReady()) return null;

    // Calculate available text width per column
    const gutterPx = viewMode === 'unified' ? 88 + 16 + 16 : 54 + 16;
    const cols = viewMode === 'three-pane' ? 3 : viewMode === 'split' ? 2 : 1;
    const textWidth = diffContainerWidth / cols - gutterPx;
    if (textWidth <= 0) return null;

    const heights = new Map<number, number>();

    for (let i = 0; i < renderRows.length; i++) {
      const row = renderRows[i];
      let maxLines = 1;

      if (row.type === 'unified-line') {
        const prepared = getCachedPrepared(row.line.text, monoFont);
        if (prepared) {
          const { lineCount } = layoutSync(prepared, textWidth, monoLineHeight);
          maxLines = Math.max(maxLines, lineCount);
        }
      } else if (row.type === 'split-pair') {
        for (const side of [row.pair.left, row.pair.right]) {
          if (side) {
            const prepared = getCachedPrepared(side.text, monoFont);
            if (prepared) {
              const { lineCount } = layoutSync(prepared, textWidth, monoLineHeight);
              maxLines = Math.max(maxLines, lineCount);
            }
          }
        }
      } else if (row.type === 'three-pane-triple') {
        for (const side of [row.triple.left, row.triple.center, row.triple.right]) {
          if (side) {
            const prepared = getCachedPrepared(side.text, monoFont);
            if (prepared) {
              const { lineCount } = layoutSync(prepared, textWidth, monoLineHeight);
              maxLines = Math.max(maxLines, lineCount);
            }
          }
        }
      }

      if (maxLines > 1) {
        heights.set(i, maxLines * monoLineHeight);
      }
    }

    return heights;
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
  });

  // Re-measure all rows when word-wrap is toggled off or font size changes
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [wordWrap, viewMode, rowHeight]); // eslint-disable-line react-hooks/exhaustive-deps

  // Measure actual max content width using a canvas for accurate monospace measurement.
  // Used by split/three-pane for the custom horizontal scrollbar AND by unified mode
  // to set an explicit container width so row backgrounds extend on horizontal scroll.
  const needsHScroll = !wordWrap && viewMode !== 'unified';
  const maxContentWidth = useMemo(() => {
    if (wordWrap) return 0;
    let maxLen = 0;
    let longestText = '';
    for (const line of parsed.lines) {
      if (line.text.length > maxLen) {
        maxLen = line.text.length;
        longestText = line.text;
      }
    }
    if (maxLen === 0) return 0;
    // Gutter: unified = 2×w-11 (88px) + w-4 (16px) + pr-4 (16px) = 120px
    //         split/three-pane = w-11 (44px) + w-4 (16px) + padding = 80px
    const gutter = viewMode === 'unified' ? 120 : 80;
    // Measure with canvas for accuracy (tabs, unicode, etc.)
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.font = `${diffFontPx}px monospace`;
        const measured = ctx.measureText(longestText);
        return Math.ceil(measured.width) + gutter;
      }
    } catch {
      /* fallback below */
    }
    const charWidth = diffFontPx * 0.655; // fallback estimate
    return Math.ceil(maxLen * charWidth) + gutter;
  }, [wordWrap, parsed.lines, viewMode, diffFontPx]);

  // Single horizontal scrollbar for split/three-pane (only when not wrapping)
  const hSpacerWidth = useHorizontalScroll(scrollRef, hScrollBarRef, needsHScroll, maxContentWidth);

  const effectiveLang = langReady ? lang : 'plaintext';
  const tooManyLines = parsed.lines.length > HIGHLIGHT_MAX_LINES;
  const highlightLang = tooManyLines ? 'plaintext' : effectiveLang;
  const hasLines = parsed.lines.length > 0;

  // ── Drag-select (GitHub Desktop-style click+drag on checkboxes) ──
  const dragRef = useRef<{
    active: boolean;
    mode: boolean;
    startLineIdx: number;
  }>({ active: false, mode: true, startLineIdx: -1 });

  const getLineIdxFromEvent = useCallback((e: React.MouseEvent | MouseEvent): number | null => {
    const el = (e.target as HTMLElement).closest('[data-line-idx]');
    if (!el) return null;
    const v = Number(el.getAttribute('data-line-idx'));
    return Number.isFinite(v) ? v : null;
  }, []);

  const handleDragMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!selectable || !onDragSelect || e.button !== 0) return;
      // Only start drag when clicking on the gutter area (checkbox / line numbers)
      const target = e.target as HTMLElement;
      if (!target.closest('[data-gutter]')) return;
      const lineIdx = getLineIdxFromEvent(e);
      if (lineIdx == null) return;
      const willSelect = !selectedLines?.has(lineIdx);
      dragRef.current = { active: true, mode: willSelect, startLineIdx: lineIdx };
      onDragSelect(lineIdx, lineIdx, willSelect);
      e.preventDefault();
    },
    [selectable, onDragSelect, selectedLines, getLineIdxFromEvent],
  );

  const handleDragMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragRef.current.active || !onDragSelect) return;
      const lineIdx = getLineIdxFromEvent(e);
      if (lineIdx == null) return;
      onDragSelect(dragRef.current.startLineIdx, lineIdx, dragRef.current.mode);
    },
    [onDragSelect, getLineIdxFromEvent],
  );

  const handleDragMouseUp = useCallback(() => {
    dragRef.current = { active: false, mode: true, startLineIdx: -1 };
  }, []);

  useEffect(() => {
    if (!selectable) return;
    const handler = () => {
      dragRef.current = { active: false, mode: true, startLineIdx: -1 };
    };
    window.addEventListener('mouseup', handler);
    return () => window.removeEventListener('mouseup', handler);
  }, [selectable]);

  // ── Sticky hunk header ──
  // Build sorted list of hunk row indices so we can find which one to stick
  const hunkRowPositions = useMemo(() => {
    const positions: { index: number; text: string; hunkStartIdx?: number }[] = [];
    for (let i = 0; i < renderRows.length; i++) {
      const row = renderRows[i];
      if (row.type === 'hunk') {
        positions.push({ index: i, text: row.text, hunkStartIdx: row.hunkStartIdx });
      }
    }
    return positions;
  }, [renderRows]);

  const [stickyHunk, setStickyHunk] = useState<{
    text: string;
    hunkStartIdx?: number;
  } | null>(null);

  // Update sticky hunk on scroll — use virtualizer range to find the stuck header
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || hunkRowPositions.length === 0) return;
    const onScroll = () => {
      const scrollTop = el.scrollTop;
      // Only show sticky when scrolled past the hunk header (not when it's still visible)
      let found: (typeof hunkRowPositions)[0] | null = null;
      for (const hp of hunkRowPositions) {
        const item = virtualizer.measurementsCache[hp.index];
        const rowTop = item ? item.start : hp.index * rowHeight;
        if (rowTop + rowHeight <= scrollTop) {
          found = hp;
        } else {
          break;
        }
      }
      setStickyHunk(found);
    };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [hunkRowPositions, virtualizer, rowHeight]);

  const gutterWidth = viewMode !== 'unified' ? 'w-[54px]' : 'w-[88px]';

  const diffContent = (
    <div
      className={cn('flex flex-col', showMinimap ? 'flex-1 min-w-0' : className)}
      data-testid={props['data-testid']}
    >
      {/* Vertical scroll area */}
      <div
        ref={scrollCallbackRef}
        className={cn(
          'flex-1 min-h-0 relative',
          needsHScroll ? 'overflow-y-auto overflow-x-hidden' : 'overflow-auto',
        )}
        onMouseDown={selectable ? handleDragMouseDown : undefined}
        onMouseMove={selectable ? handleDragMouseMove : undefined}
        onMouseUp={selectable ? handleDragMouseUp : undefined}
      >
        {/* Sticky hunk header overlay */}
        {stickyHunk && (
          <div
            className={cn(
              'sticky top-0 z-10 flex select-none items-center bg-accent/95 font-mono text-[length:var(--diff-font-size)] text-muted-foreground backdrop-blur-sm border-b border-border/50',
              selectable ? 'pr-2' : 'px-2',
            )}
            style={{ height: rowHeight, marginBottom: -rowHeight }}
            data-testid="diff-sticky-hunk"
          >
            {selectable && stickyHunk.hunkStartIdx != null ? (
              (() => {
                const indices = hunkLineMap.get(stickyHunk.hunkStartIdx!) ?? [];
                const count = indices.filter((idx) => selectedLines?.has(idx)).length;
                const allChecked = indices.length > 0 && count === indices.length;
                const isPartial = count > 0 && count < indices.length;
                return (
                  <span className="flex w-5 flex-shrink-0 items-center justify-center">
                    <TriCheckbox
                      state={isPartial ? 'indeterminate' : allChecked ? 'checked' : 'unchecked'}
                      onToggle={() => {
                        if (indices.length > 0) onHunkToggle?.(indices);
                      }}
                      data-testid="diff-sticky-hunk-checkbox"
                    />
                  </span>
                );
              })()
            ) : selectable ? (
              <span className="w-5 flex-shrink-0" />
            ) : null}
            <span className={cn(gutterWidth, 'flex-shrink-0')} />
            <span className="truncate">{stickyHunk.text}</span>
          </div>
        )}
        <div
          style={{
            height: virtualizer.getTotalSize(),
            minWidth: '100%',
            // In split/three-pane mode, horizontal scroll is handled via CSS
            // translateX on each pane's text — the container must stay at 100%
            // so flex-1 columns divide the *visible* width equally.
            // Only unified mode needs to expand the container for native h-scroll.
            width: maxContentWidth > 0 && !needsHScroll ? maxContentWidth : '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((vItem) => {
            const row = renderRows[vItem.index];

            const rowH = rowHeightMap?.get(vItem.index) ?? rowHeight;
            return (
              <div
                key={vItem.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  ...(wordWrap ? { minHeight: rowH } : { height: rowH }),
                  transform: `translateY(${vItem.start}px)`,
                }}
                {...(wordWrap
                  ? { ref: virtualizer.measureElement, 'data-index': vItem.index }
                  : {})}
              >
                {row.type === 'conflict-actions' ? (
                  <ConflictActionBar block={row.block} onResolve={onResolveConflict} />
                ) : row.type === 'hunk' ? (
                  <div
                    className={cn(
                      'flex select-none items-center bg-accent font-mono text-[length:var(--diff-font-size)] text-muted-foreground',
                      selectable ? 'pr-2' : 'px-2',
                    )}
                    style={{ height: rowHeight }}
                  >
                    {selectable && row.hunkStartIdx != null ? (
                      (() => {
                        const indices = hunkLineMap.get(row.hunkStartIdx!) ?? [];
                        const count = indices.filter((idx) => selectedLines?.has(idx)).length;
                        const allChecked = indices.length > 0 && count === indices.length;
                        const isPartial = count > 0 && count < indices.length;
                        return (
                          <span className="flex w-5 flex-shrink-0 items-center justify-center">
                            <TriCheckbox
                              state={
                                isPartial ? 'indeterminate' : allChecked ? 'checked' : 'unchecked'
                              }
                              onToggle={() => {
                                if (indices.length > 0) onHunkToggle?.(indices);
                              }}
                              data-testid={`diff-hunk-checkbox-${row.hunkStartIdx}`}
                            />
                          </span>
                        );
                      })()
                    ) : selectable ? (
                      <span className="w-5 flex-shrink-0" />
                    ) : null}
                    <span className={cn(gutterWidth, 'flex-shrink-0')} />
                    <span className="truncate">{row.text}</span>
                  </div>
                ) : row.type === 'fold' ? (
                  <button
                    className={cn(
                      'flex w-full select-none items-center bg-muted/50 font-mono text-[length:var(--diff-font-size)] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground',
                      selectable ? 'pr-2' : 'px-2',
                    )}
                    style={{ height: rowHeight }}
                    onClick={() => toggleFold(row.sectionIdx)}
                    data-testid="diff-fold-toggle"
                  >
                    {selectable && <span className="w-5 flex-shrink-0" />}
                    <span className={cn(gutterWidth, 'flex-shrink-0')} />
                    <span className="truncate">
                      @@ -{row.oldStart},{row.lineCount} +{row.newStart},{row.lineCount} @@ ·{' '}
                      {row.lineCount} lines hidden
                    </span>
                  </button>
                ) : row.type === 'three-pane-triple' ? (
                  <ThreePaneRow
                    left={row.triple.left}
                    center={row.triple.center}
                    right={row.triple.right}
                    lang={highlightLang}
                    wrap={wordWrap}
                    searchQuery={searchQuery}
                    searchCaseSensitive={searchCaseSensitive}
                    matchOffset={searchMatchData?.prefixSum[vItem.index]}
                    currentMatchIdx={currentMatchIndex}
                  />
                ) : row.type === 'split-pair' ? (
                  <SplitRow
                    left={row.pair.left}
                    right={row.pair.right}
                    lang={highlightLang}
                    wrap={wordWrap}
                    searchQuery={searchQuery}
                    searchCaseSensitive={searchCaseSensitive}
                    matchOffset={searchMatchData?.prefixSum[vItem.index]}
                    currentMatchIdx={currentMatchIndex}
                  />
                ) : (
                  <UnifiedRow
                    line={row.line}
                    lineIdx={row.lineIdx}
                    lang={highlightLang}
                    wrap={wordWrap}
                    searchQuery={searchQuery}
                    searchCaseSensitive={searchCaseSensitive}
                    matchOffset={searchMatchData?.prefixSum[vItem.index]}
                    currentMatchIdx={currentMatchIndex}
                    selectable={selectable}
                    selected={selectable ? selectedLines?.has(row.lineIdx) : undefined}
                    onToggle={onLineToggle}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {/* Single horizontal scrollbar for split/three-pane mode */}
      {needsHScroll && (
        <div
          ref={hScrollBarRef}
          className="flex-shrink-0 overflow-x-auto overflow-y-hidden"
          style={{ height: 10 }}
          data-testid="diff-h-scrollbar"
        >
          <div style={{ width: hSpacerWidth, height: 1 }} />
        </div>
      )}
    </div>
  );

  if (!hasLines) {
    return (
      <p className="p-4 text-xs text-muted-foreground" data-testid={props['data-testid']}>
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
        totalSize={virtualizer.getTotalSize()}
      />
    </div>
  );
});
