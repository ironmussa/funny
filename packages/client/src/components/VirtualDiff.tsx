import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  ensureLanguage,
  filePathToHljsLang,
  highlightLine,
  HIGHLIGHT_MAX_LINES,
} from '@/hooks/use-highlight';
import {
  getCachedPrepared,
  isPretextReady,
  layoutSync,
  prepareBatch,
  ensurePretextLoaded,
  MONO_FONT,
  MONO_LINE_HEIGHT,
} from '@/hooks/use-pretext';
import { cn } from '@/lib/utils';

/* ── Types ── */

interface DiffLine {
  type: 'add' | 'del' | 'ctx';
  text: string;
  oldNo?: number;
  newNo?: number;
}

interface DiffSection {
  kind: 'change' | 'context';
  startIdx: number;
  endIdx: number;
  collapsed: boolean;
}

type VirtualRow =
  | { type: 'line'; lineIdx: number }
  | { type: 'fold'; sectionIdx: number; lineCount: number; oldStart: number; newStart: number }
  | { type: 'hunk'; text: string };

type RenderRow =
  | { type: 'unified-line'; line: DiffLine }
  | { type: 'split-pair'; pair: SplitPair }
  | { type: 'three-pane-triple'; triple: ThreePaneTriple }
  | { type: 'fold'; sectionIdx: number; lineCount: number; oldStart: number; newStart: number }
  | { type: 'hunk'; text: string };

interface SplitPair {
  left?: DiffLine;
  right?: DiffLine;
}

interface ThreePaneTriple {
  left?: DiffLine; // old content
  center?: DiffLine; // result (clean)
  right?: DiffLine; // new content
}

export type DiffViewMode = 'unified' | 'split' | 'three-pane';

export interface VirtualDiffProps {
  /** Raw unified diff string (from gitoxide or git diff) */
  unifiedDiff: string;
  /** @deprecated Use `viewMode` instead. Split view (two columns) or unified (one column). Default: false */
  splitView?: boolean;
  /** View mode: 'unified' (1 col), 'split' (2 cols), or 'three-pane' (3 cols). Overrides splitView. */
  viewMode?: DiffViewMode;
  /** File path for syntax highlighting language detection */
  filePath?: string;
  /** Enable code folding for context sections. Default: true */
  codeFolding?: boolean;
  /** Lines of context around each change (default 3) */
  contextLines?: number;
  /** Show a minimap bar on the right with change indicators. Default: false */
  showMinimap?: boolean;
  /** Enable word wrap for long lines (uses pretext for height measurement). Default: false */
  wordWrap?: boolean;
  className?: string;
  'data-testid'?: string;
}

/* ── Parser ── */

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

interface ParsedDiff {
  lines: DiffLine[];
  hunkHeaders: Map<number, string>;
}

function parseUnifiedDiff(diff: string): ParsedDiff {
  const raw = diff.split('\n');
  const lines: DiffLine[] = [];
  const hunkHeaders = new Map<number, string>();
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  for (const line of raw) {
    const hunkMatch = HUNK_RE.exec(line);
    if (hunkMatch) {
      oldNo = parseInt(hunkMatch[1], 10);
      newNo = parseInt(hunkMatch[2], 10);
      inHunk = true;
      hunkHeaders.set(lines.length, line);
      continue;
    }

    if (!inHunk) continue;

    if (line.startsWith('+')) {
      lines.push({ type: 'add', text: line.substring(1), newNo: newNo++ });
    } else if (line.startsWith('-')) {
      lines.push({ type: 'del', text: line.substring(1), oldNo: oldNo++ });
    } else if (line.startsWith('\\')) {
      continue;
    } else {
      const text = line.length > 0 && line[0] === ' ' ? line.substring(1) : line;
      lines.push({ type: 'ctx', text, oldNo: oldNo++, newNo: newNo++ });
    }
  }

  return { lines, hunkHeaders };
}

/* ── Section builder (code folding) ── */

function buildSections(lines: DiffLine[], contextLines: number): DiffSection[] {
  if (lines.length === 0) return [];

  const sections: DiffSection[] = [];
  let currentKind: 'change' | 'context' = lines[0].type === 'ctx' ? 'context' : 'change';
  let startIdx = 0;

  for (let i = 1; i <= lines.length; i++) {
    const kind = i < lines.length ? (lines[i].type === 'ctx' ? 'context' : 'change') : 'other';
    if (kind !== currentKind || i === lines.length) {
      sections.push({ kind: currentKind, startIdx, endIdx: i - 1, collapsed: false });
      currentKind = kind as 'change' | 'context';
      startIdx = i;
    }
  }

  // Auto-collapse large context sections
  for (const section of sections) {
    if (section.kind === 'context') {
      const len = section.endIdx - section.startIdx + 1;
      if (len > contextLines * 2) section.collapsed = true;
    }
  }

  return sections;
}

/* ── Virtual row builder ── */

function buildVirtualRows(
  sections: DiffSection[],
  lines: DiffLine[],
  hunkHeaders: Map<number, string>,
  contextLines: number,
): VirtualRow[] {
  const rows: VirtualRow[] = [];

  for (let si = 0; si < sections.length; si++) {
    const section = sections[si];

    if (hunkHeaders.has(section.startIdx)) {
      rows.push({ type: 'hunk', text: hunkHeaders.get(section.startIdx)! });
    }

    if (section.kind === 'change' || !section.collapsed) {
      for (let i = section.startIdx; i <= section.endIdx; i++) {
        rows.push({ type: 'line', lineIdx: i });
      }
    } else {
      const topEnd = Math.min(section.startIdx + contextLines - 1, section.endIdx);
      const botStart = Math.max(section.endIdx - contextLines + 1, topEnd + 1);
      const foldedCount = botStart - topEnd - 1;

      for (let i = section.startIdx; i <= topEnd; i++) {
        rows.push({ type: 'line', lineIdx: i });
      }

      if (foldedCount > 0) {
        rows.push({
          type: 'fold',
          sectionIdx: si,
          lineCount: foldedCount,
          oldStart: lines[topEnd + 1]?.oldNo ?? 0,
          newStart: lines[topEnd + 1]?.newNo ?? 0,
        });
      }

      for (let i = botStart; i <= section.endIdx; i++) {
        rows.push({ type: 'line', lineIdx: i });
      }
    }
  }

  return rows;
}

/* ── Split view pairing ── */

function buildSplitPairs(lines: DiffLine[], startIdx: number, endIdx: number): SplitPair[] {
  const pairs: SplitPair[] = [];
  let i = startIdx;

  while (i <= endIdx) {
    const line = lines[i];

    if (line.type === 'ctx') {
      pairs.push({ left: line, right: line });
      i++;
    } else if (line.type === 'del') {
      const dels: DiffLine[] = [];
      while (i <= endIdx && lines[i].type === 'del') {
        dels.push(lines[i]);
        i++;
      }
      const adds: DiffLine[] = [];
      while (i <= endIdx && lines[i].type === 'add') {
        adds.push(lines[i]);
        i++;
      }
      const maxLen = Math.max(dels.length, adds.length);
      for (let j = 0; j < maxLen; j++) {
        pairs.push({ left: dels[j], right: adds[j] });
      }
    } else {
      pairs.push({ right: line });
      i++;
    }
  }

  return pairs;
}

/* ── Three-pane triple builder ── */

function buildThreePaneTriples(
  lines: DiffLine[],
  startIdx: number,
  endIdx: number,
): ThreePaneTriple[] {
  const triples: ThreePaneTriple[] = [];
  let i = startIdx;

  while (i <= endIdx) {
    const line = lines[i];

    if (line.type === 'ctx') {
      triples.push({ left: line, center: line, right: line });
      i++;
    } else if (line.type === 'del') {
      const dels: DiffLine[] = [];
      while (i <= endIdx && lines[i].type === 'del') {
        dels.push(lines[i]);
        i++;
      }
      const adds: DiffLine[] = [];
      while (i <= endIdx && lines[i].type === 'add') {
        adds.push(lines[i]);
        i++;
      }
      const maxLen = Math.max(dels.length, adds.length);
      for (let j = 0; j < maxLen; j++) {
        triples.push({
          left: dels[j],
          center: adds[j],
          right: adds[j],
        });
      }
    } else {
      // Pure addition (no preceding deletion)
      triples.push({ center: line, right: line });
      i++;
    }
  }

  return triples;
}

/* ── Highlight cache ── */

const ROW_HEIGHT = 20;
const highlightCache = new Map<string, string>();

function getCachedHighlight(text: string, lang: string): string {
  const key = `${lang}:${text}`;
  let cached = highlightCache.get(key);
  if (cached === undefined) {
    cached = highlightLine(text, lang);
    highlightCache.set(key, cached);
    if (highlightCache.size > 20_000) {
      const iter = highlightCache.keys();
      for (let i = 0; i < 5_000; i++) {
        const k = iter.next();
        if (k.done) break;
        highlightCache.delete(k.value);
      }
    }
  }
  return cached;
}

/* ── Row components ── */

const UnifiedRow = memo(function UnifiedRow({
  line,
  lang,
  wrap,
}: {
  line: DiffLine;
  lang: string;
  wrap?: boolean;
}) {
  const bgStyle =
    line.type === 'add'
      ? { backgroundColor: 'hsl(var(--diff-added) / 0.12)' }
      : line.type === 'del'
        ? { backgroundColor: 'hsl(var(--diff-removed) / 0.12)' }
        : undefined;

  const textClass =
    line.type === 'add'
      ? 'text-diff-added'
      : line.type === 'del'
        ? 'text-diff-removed'
        : 'text-foreground/80';

  const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';

  return (
    <div
      className={cn('flex font-mono text-[11px]', wrap ? 'items-start' : 'items-center')}
      style={wrap ? { minHeight: ROW_HEIGHT, ...bgStyle } : { height: ROW_HEIGHT, ...bgStyle }}
    >
      <span className="w-11 flex-shrink-0 select-none pr-1 pt-px text-right text-muted-foreground/40">
        {line.oldNo ?? ''}
      </span>
      <span className="w-11 flex-shrink-0 select-none pr-1 pt-px text-right text-muted-foreground/40">
        {line.newNo ?? ''}
      </span>
      <span className={cn('w-4 flex-shrink-0 select-none pt-px text-center', textClass)}>
        {prefix}
      </span>
      <span
        className={cn(
          wrap ? 'whitespace-pre-wrap break-all pr-4' : 'whitespace-pre pr-4',
          textClass,
        )}
        dangerouslySetInnerHTML={{ __html: getCachedHighlight(line.text, lang) }}
      />
    </div>
  );
});

/** Inline style for pane text when horizontal scroll is active (CSS variable driven).
 * position:relative + z-index:0 ensures the text stays BELOW the gutter (z-10). */
const H_SCROLL_STYLE: React.CSSProperties = {
  transform: 'translateX(calc(-1 * var(--h-scroll, 0px)))',
  position: 'relative',
  zIndex: 0,
};

const SplitRow = memo(function SplitRow({
  left,
  right,
  lang,
  wrap,
}: {
  left?: DiffLine;
  right?: DiffLine;
  lang: string;
  wrap?: boolean;
}) {
  const leftBg = left?.type === 'del' ? 'hsl(var(--diff-removed) / 0.12)' : undefined;
  const rightBg = right?.type === 'add' ? 'hsl(var(--diff-added) / 0.12)' : undefined;
  return (
    <div
      className="flex font-mono text-[11px]"
      style={wrap ? { minHeight: ROW_HEIGHT } : { height: ROW_HEIGHT }}
    >
      {/* Left (old) */}
      <div
        className={cn(
          'flex flex-1 border-r border-border/30',
          wrap ? 'items-start overflow-visible' : 'items-center overflow-hidden',
        )}
        style={leftBg ? { backgroundColor: leftBg } : undefined}
      >
        <div className="relative z-10 flex flex-shrink-0 items-center bg-background">
          <span className="w-11 flex-shrink-0 select-none pr-1 text-right text-muted-foreground/40">
            {left?.oldNo ?? ''}
          </span>
          <span
            className={cn(
              'w-4 flex-shrink-0 select-none text-center',
              left?.type === 'del' ? 'text-diff-removed' : 'text-foreground/80',
            )}
          >
            {left?.type === 'del' ? '-' : left ? ' ' : ''}
          </span>
        </div>
        {left && (
          <span
            className={cn(
              wrap ? 'whitespace-pre-wrap break-all pr-4' : 'whitespace-pre pr-4',
              left.type === 'del' ? 'text-diff-removed' : 'text-foreground/80',
            )}
            style={wrap ? undefined : H_SCROLL_STYLE}
            dangerouslySetInnerHTML={{ __html: getCachedHighlight(left.text, lang) }}
          />
        )}
      </div>
      {/* Right (new) */}
      <div
        className={cn(
          'flex flex-1',
          wrap ? 'items-start overflow-visible' : 'items-center overflow-hidden',
        )}
        style={rightBg ? { backgroundColor: rightBg } : undefined}
      >
        <div className="relative z-10 flex flex-shrink-0 items-center bg-background">
          <span className="w-11 flex-shrink-0 select-none pr-1 text-right text-muted-foreground/40">
            {right?.newNo ?? ''}
          </span>
          <span
            className={cn(
              'w-4 flex-shrink-0 select-none text-center',
              right?.type === 'add' ? 'text-diff-added' : 'text-foreground/80',
            )}
          >
            {right?.type === 'add' ? '+' : right ? ' ' : ''}
          </span>
        </div>
        {right && (
          <span
            className={cn(
              wrap ? 'whitespace-pre-wrap break-all pr-4' : 'whitespace-pre pr-4',
              right.type === 'add' ? 'text-diff-added' : 'text-foreground/80',
            )}
            style={wrap ? undefined : H_SCROLL_STYLE}
            dangerouslySetInnerHTML={{ __html: getCachedHighlight(right.text, lang) }}
          />
        )}
      </div>
    </div>
  );
});

const ThreePaneRow = memo(function ThreePaneRow({
  left,
  center,
  right,
  lang,
  wrap,
}: {
  left?: DiffLine;
  center?: DiffLine;
  right?: DiffLine;
  lang: string;
  wrap?: boolean;
}) {
  const align = wrap ? 'items-start overflow-visible' : 'items-center overflow-hidden';
  const leftBg = left?.type === 'del' ? 'hsl(var(--diff-removed) / 0.12)' : undefined;
  const rightBg = right?.type === 'add' ? 'hsl(var(--diff-added) / 0.12)' : undefined;
  return (
    <div
      className="flex font-mono text-[11px]"
      style={wrap ? { minHeight: ROW_HEIGHT } : { height: ROW_HEIGHT }}
    >
      {/* Left (old) */}
      <div
        className={cn('flex flex-1 border-r border-border/30', align)}
        style={leftBg ? { backgroundColor: leftBg } : undefined}
      >
        <div className="relative z-10 flex flex-shrink-0 items-center bg-background">
          <span className="w-11 flex-shrink-0 select-none pr-1 text-right text-muted-foreground/40">
            {left?.oldNo ?? ''}
          </span>
          <span
            className={cn(
              'w-4 flex-shrink-0 select-none text-center',
              left?.type === 'del' ? 'text-diff-removed' : 'text-foreground/80',
            )}
          >
            {left?.type === 'del' ? '-' : left ? ' ' : ''}
          </span>
        </div>
        {left && (
          <span
            className={cn(
              wrap ? 'whitespace-pre-wrap break-all pr-2' : 'whitespace-pre pr-2',
              left.type === 'del' ? 'text-diff-removed' : 'text-foreground/80',
            )}
            style={wrap ? undefined : H_SCROLL_STYLE}
            dangerouslySetInnerHTML={{ __html: getCachedHighlight(left.text, lang) }}
          />
        )}
      </div>
      {/* Center (result — clean, no diff highlighting) */}
      <div className={cn('flex flex-1 border-r border-border/30', align)}>
        <div className="relative z-10 flex flex-shrink-0 items-center bg-background">
          <span className="w-11 flex-shrink-0 select-none pr-1 text-right text-muted-foreground/40">
            {center?.newNo ?? ''}
          </span>
        </div>
        {center && (
          <span
            className={
              wrap
                ? 'whitespace-pre-wrap break-all pr-2 text-foreground'
                : 'whitespace-pre pr-2 text-foreground'
            }
            style={wrap ? undefined : H_SCROLL_STYLE}
            dangerouslySetInnerHTML={{ __html: getCachedHighlight(center.text, lang) }}
          />
        )}
      </div>
      {/* Right (new) */}
      <div
        className={cn('flex flex-1', align)}
        style={rightBg ? { backgroundColor: rightBg } : undefined}
      >
        <div className="relative z-10 flex flex-shrink-0 items-center bg-background">
          <span className="w-11 flex-shrink-0 select-none pr-1 text-right text-muted-foreground/40">
            {right?.newNo ?? ''}
          </span>
          <span
            className={cn(
              'w-4 flex-shrink-0 select-none text-center',
              right?.type === 'add' ? 'text-diff-added' : 'text-foreground/80',
            )}
          >
            {right?.type === 'add' ? '+' : right ? ' ' : ''}
          </span>
        </div>
        {right && (
          <span
            className={cn(
              wrap ? 'whitespace-pre-wrap break-all pr-2' : 'whitespace-pre pr-2',
              right.type === 'add' ? 'text-diff-added' : 'text-foreground/80',
            )}
            style={wrap ? undefined : H_SCROLL_STYLE}
            dangerouslySetInnerHTML={{ __html: getCachedHighlight(right.text, lang) }}
          />
        )}
      </div>
    </div>
  );
});

/**
 * Single horizontal scrollbar for split/three-pane mode.
 *
 * Uses a CSS custom property `--h-scroll` on the container so all pane text
 * content can apply `translateX(calc(-1 * var(--h-scroll, 0px)))` without
 * React re-renders. A thin native scrollbar at the bottom controls the offset.
 * Horizontal wheel/trackpad gestures on the diff area are also captured.
 */
function useHorizontalScroll(
  containerRef: React.RefObject<HTMLDivElement | null>,
  hScrollBarRef: React.RefObject<HTMLDivElement | null>,
  enabled: boolean,
  maxTextWidth: number,
) {
  // The spacer inside the scrollbar must be wide enough so that when the user
  // scrolls to the end, the text translateX offset reveals the full line.
  // scrollRange = spacerWidth - scrollBarVisibleWidth
  // We need: scrollRange >= maxTextWidth  →  spacerWidth >= maxTextWidth + scrollBarVisibleWidth
  const [spacerWidth, setSpacerWidth] = useState(0);

  useEffect(() => {
    const scrollBar = hScrollBarRef.current;
    if (!enabled || !scrollBar || maxTextWidth <= 0) {
      setSpacerWidth(0);
      return;
    }
    const update = () => setSpacerWidth(maxTextWidth + scrollBar.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(scrollBar);
    return () => ro.disconnect();
  }, [hScrollBarRef, enabled, maxTextWidth]);

  useEffect(() => {
    const container = containerRef.current;
    const scrollBar = hScrollBarRef.current;
    if (!enabled || !container || !scrollBar) return;

    let syncing = false;

    // Scrollbar → update CSS variable
    const onBarScroll = () => {
      if (syncing) return;
      syncing = true;
      container.style.setProperty('--h-scroll', `${scrollBar.scrollLeft}px`);
      syncing = false;
    };

    // Wheel on diff area → forward horizontal delta to scrollbar
    const onWheel = (e: WheelEvent) => {
      const dx = e.deltaX || (e.shiftKey ? e.deltaY : 0);
      if (dx === 0) return;
      e.preventDefault();
      scrollBar.scrollLeft += dx;
    };

    scrollBar.addEventListener('scroll', onBarScroll, { passive: true });
    container.addEventListener('wheel', onWheel, { passive: false });

    // Reset scroll position
    container.style.setProperty('--h-scroll', '0px');
    scrollBar.scrollLeft = 0;

    return () => {
      scrollBar.removeEventListener('scroll', onBarScroll);
      container.removeEventListener('wheel', onWheel);
      container.style.removeProperty('--h-scroll');
    };
  }, [containerRef, hScrollBarRef, enabled, maxTextWidth]);

  return spacerWidth;
}

/* ── Minimap component ── */

const MINIMAP_WIDTH = 48;

/**
 * Vertical minimap bar showing where changes are in the file.
 * Each line is rendered as a 1px-high colored strip.
 * A viewport indicator shows the currently visible region.
 * Clicking on the minimap scrolls to that position.
 */
const DiffMinimap = memo(function DiffMinimap({
  lines,
  scrollElement,
  totalSize,
}: {
  lines: DiffLine[];
  scrollElement: HTMLDivElement | null;
  /** Total virtual scroll height in px (from virtualizer.getTotalSize()) */
  totalSize: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewportTop, setViewportTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);

  // Build a flat array of line types for the minimap
  // This maps each rendered row index → 'add' | 'del' | 'ctx'
  const lineTypes = useMemo(() => {
    const types: Array<'add' | 'del' | 'ctx'> = [];
    for (const line of lines) {
      types.push(line.type);
    }
    return types;
  }, [lines]);

  // Observe container height changes
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height);
      }
    });
    ro.observe(container);
    setContainerHeight(container.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Draw the minimap canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || containerHeight === 0) return;

    const height = containerHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = MINIMAP_WIDTH * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${MINIMAP_WIDTH}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, MINIMAP_WIDTH, height);

    const totalLines = lineTypes.length;
    if (totalLines === 0) return;

    // Each line gets at least 1px, but we cap at the available height
    const lineHeight = Math.max(1, height / totalLines);
    // Use the inner area (leave padding on sides)
    const barX = 4;
    const barWidth = MINIMAP_WIDTH - 8;

    for (let i = 0; i < totalLines; i++) {
      const type = lineTypes[i];
      if (type === 'ctx') continue; // Don't draw context lines — keep it clean

      const y = (i / totalLines) * height;
      const h = Math.max(lineHeight, 2); // minimum 2px so changes are visible

      if (type === 'add') {
        ctx.fillStyle = 'hsl(142, 40%, 45%)'; // --diff-added
      } else {
        ctx.fillStyle = 'hsl(0, 45%, 55%)'; // --diff-removed
      }
      ctx.fillRect(barX, y, barWidth, h);
    }
  }, [lineTypes, containerHeight]);

  // Track viewport position via scroll events
  useEffect(() => {
    if (!scrollElement) return;

    const updateViewport = () => {
      const totalHeight = totalSize;
      if (totalHeight === 0 || containerHeight === 0) return;

      const scrollTop = scrollElement.scrollTop;
      const clientHeight = scrollElement.clientHeight;

      const ratio = containerHeight / totalHeight;
      setViewportTop(scrollTop * ratio);
      setViewportHeight(Math.max(clientHeight * ratio, 20)); // min 20px handle
    };

    updateViewport();
    scrollElement.addEventListener('scroll', updateViewport, { passive: true });
    const ro = new ResizeObserver(updateViewport);
    ro.observe(scrollElement);

    return () => {
      scrollElement.removeEventListener('scroll', updateViewport);
      ro.disconnect();
    };
  }, [scrollElement, totalSize, containerHeight]);

  // Handle click → scroll to position
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!scrollElement || containerHeight === 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const clickY = e.clientY - rect.top;
      const ratio = clickY / containerHeight;

      const clientHeight = scrollElement.clientHeight;
      const targetScroll = ratio * totalSize - clientHeight / 2;

      scrollElement.scrollTo({
        top: Math.max(0, Math.min(targetScroll, totalSize - clientHeight)),
      });
    },
    [scrollElement, containerHeight, totalSize],
  );

  // Handle drag on viewport indicator
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (!scrollElement || containerHeight === 0) return;

      const startY = e.clientY;
      const startScroll = scrollElement.scrollTop;
      const scale = totalSize / containerHeight;

      const onMove = (ev: MouseEvent) => {
        const deltaY = ev.clientY - startY;
        scrollElement.scrollTop = startScroll + deltaY * scale;
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [scrollElement, containerHeight, totalSize],
  );

  return (
    <div
      ref={containerRef}
      className="relative flex-shrink-0 cursor-pointer border-l border-border/50 bg-muted/20"
      style={{ width: MINIMAP_WIDTH }}
      onClick={handleClick}
      data-testid="diff-minimap"
    >
      <canvas ref={canvasRef} className="block" />
      {/* Viewport indicator */}
      <div
        className="absolute left-0 right-0 rounded-sm border border-foreground/20 bg-foreground/10"
        style={{
          top: viewportTop,
          height: viewportHeight,
        }}
        onMouseDown={handleMouseDown}
        data-testid="diff-minimap-viewport"
      />
    </div>
  );
});

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
  className,
  ...props
}: VirtualDiffProps) {
  const viewMode: DiffViewMode = viewModeProp ?? (splitView ? 'split' : 'unified');
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
        .filter((t) => t.length > 0 && !getCachedPrepared(t, MONO_FONT));
      // Deduplicate
      const unique = [...new Set(toPrepare)];
      if (unique.length > 0) {
        prepareBatch(unique, MONO_FONT).then(() => {
          if (!cancelled) setPretextReady(true);
        });
      } else {
        setPretextReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [wordWrap, parsed.lines]);

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

  // Build intermediate VirtualRow list
  const rows = useMemo((): VirtualRow[] => {
    if (!codeFolding) {
      const r: VirtualRow[] = [];
      const sortedHunks = [...parsed.hunkHeaders.entries()].sort((a, b) => a[0] - b[0]);
      let nextHunkI = 0;
      for (let i = 0; i < parsed.lines.length; i++) {
        if (nextHunkI < sortedHunks.length && sortedHunks[nextHunkI][0] === i) {
          r.push({ type: 'hunk', text: sortedHunks[nextHunkI][1] });
          nextHunkI++;
        }
        r.push({ type: 'line', lineIdx: i });
      }
      return r;
    }
    return buildVirtualRows(effectiveSections, parsed.lines, parsed.hunkHeaders, contextLines);
  }, [codeFolding, effectiveSections, parsed.lines, parsed.hunkHeaders, contextLines]);

  // Build final render rows (handles split/three-pane pairing)
  const renderRows = useMemo((): RenderRow[] => {
    if (viewMode === 'split' || viewMode === 'three-pane') {
      const result: RenderRow[] = [];
      let i = 0;
      while (i < rows.length) {
        const row = rows[i];
        if (row.type === 'hunk') {
          result.push({ type: 'hunk', text: row.text });
          i++;
        } else if (row.type === 'fold') {
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
      if (row.type === 'hunk') return { type: 'hunk', text: row.text };
      if (row.type === 'fold') return row;
      return { type: 'unified-line', line: parsed.lines[row.lineIdx] };
    });
  }, [viewMode, rows, parsed.lines]);

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
        const prepared = getCachedPrepared(row.line.text, MONO_FONT);
        if (prepared) {
          const { lineCount } = layoutSync(prepared, textWidth, MONO_LINE_HEIGHT);
          maxLines = Math.max(maxLines, lineCount);
        }
      } else if (row.type === 'split-pair') {
        for (const side of [row.pair.left, row.pair.right]) {
          if (side) {
            const prepared = getCachedPrepared(side.text, MONO_FONT);
            if (prepared) {
              const { lineCount } = layoutSync(prepared, textWidth, MONO_LINE_HEIGHT);
              maxLines = Math.max(maxLines, lineCount);
            }
          }
        }
      } else if (row.type === 'three-pane-triple') {
        for (const side of [row.triple.left, row.triple.center, row.triple.right]) {
          if (side) {
            const prepared = getCachedPrepared(side.text, MONO_FONT);
            if (prepared) {
              const { lineCount } = layoutSync(prepared, textWidth, MONO_LINE_HEIGHT);
              maxLines = Math.max(maxLines, lineCount);
            }
          }
        }
      }

      if (maxLines > 1) {
        heights.set(i, maxLines * MONO_LINE_HEIGHT);
      }
    }

    return heights;
  }, [wordWrap, pretextReady, diffContainerWidth, viewMode, renderRows]);

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
    estimateSize: (index) => (rowHeightMap ? (rowHeightMap.get(index) ?? ROW_HEIGHT) : ROW_HEIGHT),
    overscan: 30,
  });

  // Re-measure all rows when word-wrap is toggled off so heights reset to fixed ROW_HEIGHT
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [wordWrap, viewMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Measure actual max content width using a canvas for accurate monospace measurement
  const needsHScroll = !wordWrap && viewMode !== 'unified';
  const maxContentWidth = useMemo(() => {
    if (!needsHScroll) return 0;
    let maxLen = 0;
    let longestText = '';
    for (const line of parsed.lines) {
      if (line.text.length > maxLen) {
        maxLen = line.text.length;
        longestText = line.text;
      }
    }
    if (maxLen === 0) return 0;
    // Measure with canvas for accuracy (tabs, unicode, etc.)
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.font = '11px monospace';
        const measured = ctx.measureText(longestText);
        return measured.width + 80; // measured width + gutter + padding
      }
    } catch {
      /* fallback below */
    }
    return maxLen * 7.2 + 80; // fallback estimate
  }, [needsHScroll, parsed.lines]);

  // Single horizontal scrollbar for split/three-pane (only when not wrapping)
  const hSpacerWidth = useHorizontalScroll(scrollRef, hScrollBarRef, needsHScroll, maxContentWidth);

  const effectiveLang = langReady ? lang : 'plaintext';
  const tooManyLines = parsed.lines.length > HIGHLIGHT_MAX_LINES;
  const highlightLang = tooManyLines ? 'plaintext' : effectiveLang;

  if (parsed.lines.length === 0) {
    return (
      <p className="p-4 text-xs text-muted-foreground" data-testid={props['data-testid']}>
        No diff available
      </p>
    );
  }

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
          'flex-1 min-h-0',
          needsHScroll ? 'overflow-y-auto overflow-x-hidden' : 'overflow-auto',
        )}
      >
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((vItem) => {
            const row = renderRows[vItem.index];

            const rowH = rowHeightMap?.get(vItem.index) ?? ROW_HEIGHT;
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
                {row.type === 'hunk' ? (
                  <div
                    className="flex items-center bg-accent/50 px-2 font-mono text-[11px] text-muted-foreground"
                    style={{ height: ROW_HEIGHT }}
                  >
                    <span className={cn(gutterWidth, 'flex-shrink-0 select-none')} />
                    <span className="truncate">{row.text}</span>
                  </div>
                ) : row.type === 'fold' ? (
                  <button
                    className="flex w-full items-center bg-muted/50 px-2 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                    style={{ height: ROW_HEIGHT }}
                    onClick={() => toggleFold(row.sectionIdx)}
                    data-testid="diff-fold-toggle"
                  >
                    <span className={cn(gutterWidth, 'flex-shrink-0 select-none')} />
                    <span className="truncate">
                      @@ -{row.oldStart},{row.lineCount} +{row.newStart},{row.lineCount} @@ —{' '}
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
                  />
                ) : row.type === 'split-pair' ? (
                  <SplitRow
                    left={row.pair.left}
                    right={row.pair.right}
                    lang={highlightLang}
                    wrap={wordWrap}
                  />
                ) : (
                  <UnifiedRow line={row.line} lang={highlightLang} wrap={wordWrap} />
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
