import { getCachedPrepared, layoutSync } from '@/hooks/use-pretext';
import type { DiffSection } from '@/lib/diff-math';
import { countTextMatches } from '@/lib/diff/highlight';
import { buildSplitPairs, buildThreePaneTriples, buildVirtualRows } from '@/lib/diff/layout';
import type {
  ConflictBlock,
  DiffLine,
  DiffViewMode,
  RenderRow,
  VirtualRow,
} from '@/lib/diff/types';

/**
 * Pure row-model builders for `VirtualDiff`: parsed diff → virtual rows →
 * render rows, plus the search, word-wrap and width measurements over them.
 */

/** Map from hunk header line-index → all add/del line indices in that hunk. */
export function buildHunkLineMap(
  hunkHeaders: Map<number, string>,
  lines: DiffLine[],
): Map<number, number[]> {
  const map = new Map<number, number[]>();
  const sortedHeaders = Array.from(hunkHeaders.keys()).toSorted((a, b) => a - b);
  for (let h = 0; h < sortedHeaders.length; h++) {
    const start = sortedHeaders[h];
    const end = h + 1 < sortedHeaders.length ? sortedHeaders[h + 1] : lines.length;
    const changeIndices: number[] = [];
    for (let i = start; i < end; i++) {
      const line = lines[i];
      if (line && (line.type === 'add' || line.type === 'del')) {
        changeIndices.push(i);
      }
    }
    map.set(start, changeIndices);
  }
  return map;
}

/** Line indices where conflict action bars are injected (the marker-start line). */
export function buildConflictStartLines(blocks: ConflictBlock[]): Map<number, ConflictBlock> {
  const s = new Map<number, ConflictBlock>();
  for (const block of blocks) {
    s.set(block.startLineIdx, block);
  }
  return s;
}

function buildUnfoldedRows(
  lines: DiffLine[],
  hunkHeaders: Map<number, string>,
  conflictStartLines: Map<number, ConflictBlock>,
): VirtualRow[] {
  const r: VirtualRow[] = [];
  const sortedHunks = Array.from(hunkHeaders.entries()).toSorted((a, b) => a[0] - b[0]);
  let nextHunkI = 0;
  for (let i = 0; i < lines.length; i++) {
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

/** Intermediate VirtualRow list (hunks, folds, lines, conflict bars). */
export function buildDiffRows({
  codeFolding,
  effectiveSections,
  lines,
  hunkHeaders,
  contextLines,
  conflictStartLines,
}: {
  codeFolding: boolean;
  effectiveSections: DiffSection[];
  lines: DiffLine[];
  hunkHeaders: Map<number, string>;
  contextLines: number;
  conflictStartLines: Map<number, ConflictBlock>;
}): VirtualRow[] {
  if (!codeFolding) return buildUnfoldedRows(lines, hunkHeaders, conflictStartLines);
  const base = buildVirtualRows(effectiveSections, lines, hunkHeaders, contextLines);
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
}

type NonLineRow = Exclude<VirtualRow, { type: 'line' }>;

/** A hunk, fold or conflict-bar row as its render row. */
function nonLineRenderRow(row: NonLineRow): RenderRow {
  if (row.type === 'hunk') return { type: 'hunk', text: row.text, hunkStartIdx: row.hunkStartIdx };
  return row;
}

/** A run of consecutive line rows: the index after it and its last line index. */
interface LineRun {
  next: number;
  lineEnd: number;
}

/** Index past the run of consecutive line rows starting at `start`, and the run's last line index. */
function lineRunEnd(rows: VirtualRow[], start: number): LineRun {
  let lineEnd = -1;
  let j = start;
  for (; j < rows.length; j++) {
    const row = rows[j];
    if (row.type !== 'line') break;
    lineEnd = row.lineIdx;
  }
  return { next: j, lineEnd };
}

/** Append the lines `lineStart..lineEnd` paired (split) or tripled (three-pane). */
function pushPairedLineRows(
  result: RenderRow[],
  viewMode: DiffViewMode,
  lines: DiffLine[],
  lineStart: number,
  lineEnd: number,
): void {
  if (viewMode === 'three-pane') {
    for (const triple of buildThreePaneTriples(lines, lineStart, lineEnd)) {
      result.push({ type: 'three-pane-triple', triple });
    }
    return;
  }
  for (const pair of buildSplitPairs(lines, lineStart, lineEnd)) {
    result.push({ type: 'split-pair', pair });
  }
}

function buildPairedRenderRows(
  viewMode: DiffViewMode,
  rows: VirtualRow[],
  lines: DiffLine[],
): RenderRow[] {
  const result: RenderRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.type !== 'line') {
      result.push(nonLineRenderRow(row));
      i++;
      continue;
    }
    // Collect consecutive line rows
    const { next, lineEnd } = lineRunEnd(rows, i);
    pushPairedLineRows(result, viewMode, lines, row.lineIdx, lineEnd);
    i = next;
  }
  return result;
}

/** Final render rows (handles split/three-pane pairing). */
export function buildRenderRows(
  viewMode: DiffViewMode,
  rows: VirtualRow[],
  lines: DiffLine[],
): RenderRow[] {
  if (viewMode === 'split' || viewMode === 'three-pane') {
    return buildPairedRenderRows(viewMode, rows, lines);
  }

  return rows.map((row): RenderRow => {
    if (row.type !== 'line') return nonLineRenderRow(row);
    return { type: 'unified-line', line: lines[row.lineIdx], lineIdx: row.lineIdx };
  });
}

/** The texts a render row shows, one per pane. */
function rowTexts(row: RenderRow): (DiffLine | undefined)[] {
  if (row.type === 'unified-line') return [row.line];
  if (row.type === 'split-pair') return [row.pair.left, row.pair.right];
  if (row.type === 'three-pane-triple')
    return [row.triple.left, row.triple.center, row.triple.right];
  return [];
}

/**
 * For each renderRow, count matches in all panes' text (left + right / left +
 * center + right). Builds a prefix-sum so we can map globalMatchIndex →
 * rowIndex and compute per-row offsets.
 */
export function computeSearchMatchData(
  renderRows: RenderRow[],
  q: string,
  searchCaseSensitive: boolean,
) {
  const perRow: number[] = [];

  for (const row of renderRows) {
    let count = 0;
    for (const side of rowTexts(row)) {
      if (side) count += countTextMatches(side.text, q, searchCaseSensitive);
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
}

/** Gutter width (line numbers + markers) per pane, in pixels. */
const WRAP_GUTTER_PX: Record<DiffViewMode, number> = {
  unified: 88 + 16 + 16,
  split: 54 + 16,
  'three-pane': 54 + 16,
};

const PANE_COUNT: Record<DiffViewMode, number> = { unified: 1, split: 2, 'three-pane': 3 };

/** Wrapped line count of the tallest pane of a row (at least 1). */
function rowWrappedLines(
  row: RenderRow,
  textWidth: number,
  monoFont: string,
  monoLineHeight: number,
): number {
  let maxLines = 1;
  for (const side of rowTexts(row)) {
    const prepared = side && getCachedPrepared(side.text, monoFont);
    if (prepared) {
      const { lineCount } = layoutSync(prepared, textWidth, monoLineHeight);
      maxLines = Math.max(maxLines, lineCount);
    }
  }
  return maxLines;
}

/** Per-row height map for word-wrap mode (only rows taller than one line). */
export function computeRowHeightMap({
  diffContainerWidth,
  viewMode,
  renderRows,
  monoFont,
  monoLineHeight,
}: {
  diffContainerWidth: number;
  viewMode: DiffViewMode;
  renderRows: RenderRow[];
  monoFont: string;
  monoLineHeight: number;
}): Map<number, number> | null {
  // Calculate available text width per column
  const textWidth = diffContainerWidth / PANE_COUNT[viewMode] - WRAP_GUTTER_PX[viewMode];
  if (textWidth <= 0) return null;

  const heights = new Map<number, number>();

  for (let i = 0; i < renderRows.length; i++) {
    const maxLines = rowWrappedLines(renderRows[i], textWidth, monoFont, monoLineHeight);
    if (maxLines > 1) {
      heights.set(i, maxLines * monoLineHeight);
    }
  }

  return heights;
}

/**
 * Max content width of the diff, measured with a canvas for accurate
 * monospace measurement (tabs, unicode, etc.), plus the gutter.
 */
export function measureMaxContentWidth(
  lines: DiffLine[],
  viewMode: DiffViewMode,
  diffFontPx: number,
): number {
  let maxLen = 0;
  let longestText = '';
  for (const line of lines) {
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
}
