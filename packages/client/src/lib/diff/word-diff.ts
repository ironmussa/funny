import type { DiffLine } from '@/lib/diff-math';

/**
 * Word-level (intra-line) diff.
 *
 * Computed ONCE per del/add pair in a post-parse pass and stored on the shared
 * `DiffLine` objects (`segments`), so all three diff views — unified, split,
 * three-pane — consume the same data without re-pairing lines. The pairing here
 * mirrors `buildSplitPairs` / `buildThreePaneTriples` (`del[j]` ↔ `add[j]`), so
 * the highlighted ranges stay consistent across views.
 */

const WORD_RE = /\s+|[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/g;

function tokenize(s: string): string[] {
  return s.match(WORD_RE) ?? [];
}

/** Half-open char range `[start, end)` into the line's raw text. */
export type CharRange = [number, number];

export interface WordDiffResult {
  del: CharRange[];
  add: CharRange[];
}

const EMPTY: WordDiffResult = { del: [], add: [] };

// Bounds the O(n·m) LCS on pathological (e.g. minified) lines.
const MAX_TOKEN_PRODUCT = 160_000;

/**
 * Token-level LCS between two lines; returns the char ranges that changed on
 * each side. Returns no ranges when the lines share nothing in common (the
 * whole-line background already conveys the change) or when the inputs are too
 * large to diff cheaply.
 */
export function computeWordDiff(oldText: string, newText: string): WordDiffResult {
  if (!oldText || !newText || oldText === newText) return EMPTY;
  const a = tokenize(oldText);
  const b = tokenize(newText);
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0 || n * m > MAX_TOKEN_PRODUCT) return EMPTY;

  // Suffix-LCS length matrix: dp[i*W+j] = LCS(a[i..], b[j..]).
  const W = m + 1;
  const dp = new Int32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    const ai = a[i];
    const rowBase = i * W;
    const nextBase = (i + 1) * W;
    for (let j = m - 1; j >= 0; j--) {
      dp[rowBase + j] =
        ai === b[j] ? dp[nextBase + j + 1] + 1 : Math.max(dp[nextBase + j], dp[rowBase + j + 1]);
    }
  }

  const aMatched = new Uint8Array(n);
  const bMatched = new Uint8Array(m);
  let i = 0;
  let j = 0;
  let common = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      aMatched[i] = 1;
      bMatched[j] = 1;
      common++;
      i++;
      j++;
    } else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  // Nothing in common → a wholesale rewrite; let the line background carry it.
  if (common === 0) return EMPTY;

  return {
    del: rangesFromUnmatched(a, aMatched),
    add: rangesFromUnmatched(b, bMatched),
  };
}

function rangesFromUnmatched(toks: string[], matched: Uint8Array): CharRange[] {
  const ranges: CharRange[] = [];
  let pos = 0;
  let runStart = -1;
  for (let i = 0; i < toks.length; i++) {
    const len = toks[i].length;
    if (matched[i] === 0) {
      if (runStart === -1) runStart = pos;
    } else if (runStart !== -1) {
      ranges.push([runStart, pos]);
      runStart = -1;
    }
    pos += len;
  }
  if (runStart !== -1) ranges.push([runStart, pos]);
  return ranges;
}

/**
 * Walk the parsed lines and attach `segments` to each paired del/add line.
 * Mutates in place — the line objects are shared by every view.
 */
export function annotateWordDiff(lines: DiffLine[]): void {
  if (lines.length > 50_000) return;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== 'del') {
      i++;
      continue;
    }
    const delStart = i;
    while (i < lines.length && lines[i].type === 'del') i++;
    const delEnd = i;
    const addStart = i;
    while (i < lines.length && lines[i].type === 'add') i++;
    const addEnd = i;

    const pairs = Math.min(delEnd - delStart, addEnd - addStart);
    for (let k = 0; k < pairs; k++) {
      const del = lines[delStart + k];
      const add = lines[addStart + k];
      // Conflict-marker regions render with their own colors; leave them alone.
      if (del.conflictRole || add.conflictRole) continue;
      const { del: dr, add: ar } = computeWordDiff(del.text, add.text);
      if (dr.length) del.segments = dr;
      if (ar.length) add.segments = ar;
    }
  }
}
