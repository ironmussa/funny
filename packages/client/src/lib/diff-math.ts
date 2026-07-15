import { annotateWordDiff } from '@/lib/diff/word-diff';
import { metric, startSpan } from '@/lib/telemetry';

/* ── Types ── */

export type ConflictRole = 'marker-start' | 'ours' | 'separator' | 'theirs' | 'marker-end';

export interface DiffLine {
  type: 'add' | 'del' | 'ctx';
  text: string;
  oldNo?: number;
  newNo?: number;
  /** When this line is part of a conflict block */
  conflictRole?: ConflictRole;
  /** Index of the conflict block (0-based) */
  conflictBlockId?: number;
  /**
   * Char ranges `[start, end)` into `text` that changed vs the paired line
   * (intra-line word diff). Set by `annotateWordDiff`. Absent when the whole
   * line changed or there's no paired counterpart.
   */
  segments?: import('@/lib/diff/word-diff').CharRange[];
}

export interface ConflictBlock {
  id: number;
  startLineIdx: number;
  separatorLineIdx: number;
  endLineIdx: number;
  oursLabel: string; // e.g. "HEAD"
  theirsLabel: string; // e.g. "main"
}

export interface DiffSection {
  kind: 'change' | 'context';
  startIdx: number;
  endIdx: number;
  collapsed: boolean;
}

export type VirtualRow =
  | { type: 'line'; lineIdx: number }
  | { type: 'fold'; sectionIdx: number; lineCount: number; oldStart: number; newStart: number }
  | { type: 'hunk'; text: string; hunkStartIdx: number }
  | { type: 'conflict-actions'; block: ConflictBlock };

export interface SplitPair {
  left?: DiffLine;
  right?: DiffLine;
}

export interface ThreePaneTriple {
  left?: DiffLine; // old content
  center?: DiffLine; // result (clean)
  right?: DiffLine; // new content
}

/* ── Parser ── */

export const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
/**
 * Git's combined diff format for merge commits. It contains one old range per
 * parent and one new range for the merge result, e.g.
 * `@@@ -10,2 -12,2 +10,3 @@@`.
 */
export const COMBINED_HUNK_RE = /^@@@ ((?:-\d+(?:,\d+)? )+)\+(\d+)(?:,\d+)? @@@/;

/** Conflict marker patterns (match the text content after the diff prefix is stripped) */
export const CONFLICT_START_RE = /^<{7}\s?(.*)/;
export const CONFLICT_SEP_RE = /^={7}$/;
export const CONFLICT_END_RE = /^>{7}\s?(.*)/;

export interface ParsedDiff {
  lines: DiffLine[];
  hunkHeaders: Map<number, string>;
  conflictBlocks: ConflictBlock[];
}

/**
 * Post-process parsed lines to detect and annotate conflict marker blocks.
 * Scans for <<<<<<< ... ======= ... >>>>>>> sequences and annotates
 * each line with its conflict role and block ID.
 */
export function annotateConflicts(lines: DiffLine[]): ConflictBlock[] {
  const blocks: ConflictBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const startMatch = CONFLICT_START_RE.exec(lines[i].text);
    if (!startMatch) {
      i++;
      continue;
    }

    // Found <<<<<<< — scan forward for ======= and >>>>>>>
    const startIdx = i;
    const oursLabel = startMatch[1]?.trim() || 'Current';
    let sepIdx = -1;
    let endIdx = -1;

    for (let j = startIdx + 1; j < lines.length; j++) {
      if (CONFLICT_SEP_RE.test(lines[j].text) && sepIdx === -1) {
        sepIdx = j;
      } else if (sepIdx !== -1) {
        const endMatch = CONFLICT_END_RE.exec(lines[j].text);
        if (endMatch) {
          endIdx = j;
          const theirsLabel = endMatch[1]?.trim() || 'Incoming';

          const blockId = blocks.length;
          const block: ConflictBlock = {
            id: blockId,
            startLineIdx: startIdx,
            separatorLineIdx: sepIdx,
            endLineIdx: endIdx,
            oursLabel,
            theirsLabel,
          };
          blocks.push(block);

          // Annotate all lines in this block
          lines[startIdx].conflictRole = 'marker-start';
          lines[startIdx].conflictBlockId = blockId;

          for (let k = startIdx + 1; k < sepIdx; k++) {
            lines[k].conflictRole = 'ours';
            lines[k].conflictBlockId = blockId;
          }

          lines[sepIdx].conflictRole = 'separator';
          lines[sepIdx].conflictBlockId = blockId;

          for (let k = sepIdx + 1; k < endIdx; k++) {
            lines[k].conflictRole = 'theirs';
            lines[k].conflictBlockId = blockId;
          }

          lines[endIdx].conflictRole = 'marker-end';
          lines[endIdx].conflictBlockId = blockId;

          i = endIdx + 1;
          break;
        }
      }
    }

    // If we didn't find a complete block, skip this line
    if (endIdx === -1) {
      i++;
    }
  }

  return blocks;
}

export function parseUnifiedDiff(diff: string): ParsedDiff {
  const span = startSpan('diff.parseUnifiedDiff', {
    attributes: { 'input.bytes': diff.length },
  });
  const raw = diff.split('\n');
  const lines: DiffLine[] = [];
  const hunkHeaders = new Map<number, string>();
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  let combinedPrefixWidth = 0;

  for (const line of raw) {
    const hunkMatch = HUNK_RE.exec(line);
    if (hunkMatch) {
      oldNo = parseInt(hunkMatch[1], 10);
      newNo = parseInt(hunkMatch[2], 10);
      inHunk = true;
      combinedPrefixWidth = 0;
      hunkHeaders.set(lines.length, line);
      continue;
    }

    const combinedHunkMatch = COMBINED_HUNK_RE.exec(line);
    if (combinedHunkMatch) {
      // A combined diff has one prefix column per merge parent. The visualizer
      // has one "before" pane, so we render a result-oriented two-way view:
      // a line absent from the result is deleted; one present only in the
      // result is added; and a line present everywhere is context.
      const oldStart = /-(\d+)/.exec(combinedHunkMatch[1]);
      oldNo = oldStart ? parseInt(oldStart[1], 10) : 0;
      newNo = parseInt(combinedHunkMatch[2], 10);
      inHunk = true;
      combinedPrefixWidth = (combinedHunkMatch[1].match(/-\d+(?:,\d+)?/g) ?? []).length;
      hunkHeaders.set(lines.length, line);
      continue;
    }

    if (!inHunk) continue;

    if (line.startsWith('\\')) continue;

    if (combinedPrefixWidth > 0) {
      const prefix = line.slice(0, combinedPrefixWidth);
      const text = line.slice(combinedPrefixWidth);

      // `+` means the line is present in the merge result but absent from at
      // least one parent. Prefer it when both signs occur so the result pane
      // remains faithful to the merged file.
      if (prefix.includes('+')) {
        lines.push({ type: 'add', text, newNo: newNo++ });
      } else if (prefix.includes('-')) {
        lines.push({ type: 'del', text, oldNo: oldNo++ });
      } else {
        lines.push({ type: 'ctx', text, oldNo: oldNo++, newNo: newNo++ });
      }
      continue;
    }

    if (line.startsWith('+')) {
      lines.push({ type: 'add', text: line.substring(1), newNo: newNo++ });
    } else if (line.startsWith('-')) {
      lines.push({ type: 'del', text: line.substring(1), oldNo: oldNo++ });
    } else {
      const text = line.length > 0 && line[0] === ' ' ? line.substring(1) : line;
      lines.push({ type: 'ctx', text, oldNo: oldNo++, newNo: newNo++ });
    }
  }

  const conflictBlocks = annotateConflicts(lines);
  annotateWordDiff(lines);
  span.end();
  metric('diff.parse.lines', lines.length, { type: 'gauge' });
  metric('diff.parse.hunks', hunkHeaders.size, { type: 'gauge' });
  if (conflictBlocks.length > 0) {
    metric('diff.parse.conflict_blocks', conflictBlocks.length, { type: 'sum' });
  }
  return { lines, hunkHeaders, conflictBlocks };
}

/* ── Section builder (code folding) ── */

export function buildSections(lines: DiffLine[], contextLines: number): DiffSection[] {
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

export function buildVirtualRows(
  sections: DiffSection[],
  lines: DiffLine[],
  hunkHeaders: Map<number, string>,
  contextLines: number,
): VirtualRow[] {
  const rows: VirtualRow[] = [];

  // Helper: push a hunk header row if one exists at this line index
  const maybeHunk = (idx: number) => {
    if (hunkHeaders.has(idx)) {
      rows.push({ type: 'hunk', text: hunkHeaders.get(idx)!, hunkStartIdx: idx });
    }
  };

  // Helper: push line rows for a range, injecting any hunk headers that fall within
  const pushLinesWithHunks = (from: number, to: number) => {
    for (let i = from; i <= to; i++) {
      maybeHunk(i);
      rows.push({ type: 'line', lineIdx: i });
    }
  };

  for (let si = 0; si < sections.length; si++) {
    const section = sections[si];

    if (section.kind === 'change' || !section.collapsed) {
      pushLinesWithHunks(section.startIdx, section.endIdx);
    } else {
      const topEnd = Math.min(section.startIdx + contextLines - 1, section.endIdx);
      const botStart = Math.max(section.endIdx - contextLines + 1, topEnd + 1);
      const foldedCount = botStart - topEnd - 1;

      pushLinesWithHunks(section.startIdx, topEnd);

      if (foldedCount > 0) {
        rows.push({
          type: 'fold',
          sectionIdx: si,
          lineCount: foldedCount,
          oldStart: lines[topEnd + 1]?.oldNo ?? 0,
          newStart: lines[topEnd + 1]?.newNo ?? 0,
        });
      }

      pushLinesWithHunks(botStart, section.endIdx);
    }
  }

  return rows;
}

/* ── Split view pairing ── */

export function buildSplitPairs(lines: DiffLine[], startIdx: number, endIdx: number): SplitPair[] {
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

export function buildThreePaneTriples(
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

/* ── View-mode heuristics ── */

/**
 * A diff is "one-sided" when it only adds or only removes lines — i.e. a freshly
 * created or fully deleted file. Split / three-pane views would render an empty
 * column for these, so callers force unified ('1 column') mode.
 *
 * Detection prefers the git status (cheap + authoritative) and otherwise falls
 * back to the diff content, so the rule holds even where no file status is
 * available — e.g. the thread's Edit/Write tool cards and the end-of-session
 * changed-files summary, which open a single file without a `files` list.
 */
export function isOneSidedDiff(input: {
  status?: string;
  rawDiff?: string;
  oldValue?: string;
  newValue?: string;
}): boolean {
  if (input.status === 'added' || input.status === 'deleted') return true;

  if (input.rawDiff) {
    let hasAdd = false;
    let hasDel = false;
    for (const line of input.rawDiff.split('\n')) {
      // Skip the +++/--- file headers; only body lines reveal add/del.
      if (line.startsWith('+') && !line.startsWith('+++')) hasAdd = true;
      else if (line.startsWith('-') && !line.startsWith('---')) hasDel = true;
      if (hasAdd && hasDel) return false;
    }
    return hasAdd !== hasDel;
  }

  // No raw diff: infer from the snippet/file values. Exactly one side empty ⇒
  // pure add or pure delete; both present ⇒ a real two-sided change.
  return Boolean(input.oldValue) !== Boolean(input.newValue);
}

/* ── Search utilities ── */

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function countTextMatches(text: string, query: string, caseSensitive = false): number {
  if (!query) return 0;
  const q = caseSensitive ? query : query.toLowerCase();
  const t = caseSensitive ? text : text.toLowerCase();
  let count = 0;
  let pos = 0;
  while ((pos = t.indexOf(q, pos)) !== -1) {
    count++;
    pos += q.length;
  }
  return count;
}
