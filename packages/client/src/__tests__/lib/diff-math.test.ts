import { describe, test, expect, vi } from 'vitest';

import {
  annotateConflicts,
  buildSections,
  buildSplitPairs,
  buildThreePaneTriples,
  buildVirtualRows,
  countTextMatches,
  escapeRegExp,
  isOneSidedDiff,
  parseUnifiedDiff,
  type DiffLine,
} from '@/lib/diff-math';

vi.mock('@/lib/telemetry', () => ({
  metric: vi.fn(),
  startSpan: vi.fn(() => ({ end: vi.fn() })),
}));

const SAMPLE_DIFF = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,4 +1,4 @@',
  ' ctx',
  '-old',
  '+new',
  ' tail',
].join('\n');

describe('parseUnifiedDiff', () => {
  test('parses hunk lines with old/new line numbers', () => {
    const { lines, hunkHeaders } = parseUnifiedDiff(SAMPLE_DIFF);

    expect(hunkHeaders.size).toBe(1);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({ type: 'ctx', text: 'ctx', oldNo: 1, newNo: 1 });
    expect(lines[1]).toMatchObject({ type: 'del', text: 'old', oldNo: 2 });
    expect(lines[2]).toMatchObject({ type: 'add', text: 'new', newNo: 2 });
    expect(lines[3]).toMatchObject({ type: 'ctx', text: 'tail', oldNo: 3, newNo: 3 });
  });

  test('detects merge conflict markers', () => {
    const conflictDiff = [
      '@@ -1,6 +1,6 @@',
      '<<<<<<< HEAD',
      'ours',
      '=======',
      'theirs',
      '>>>>>>> main',
    ].join('\n');

    const { lines, conflictBlocks } = parseUnifiedDiff(conflictDiff);

    expect(conflictBlocks).toHaveLength(1);
    expect(conflictBlocks[0]).toMatchObject({
      id: 0,
      oursLabel: 'HEAD',
      theirsLabel: 'main',
    });
    expect(lines[0].conflictRole).toBe('marker-start');
    expect(lines[1].conflictRole).toBe('ours');
    expect(lines[2].conflictRole).toBe('separator');
    expect(lines[3].conflictRole).toBe('theirs');
    expect(lines[4].conflictRole).toBe('marker-end');
  });
});

describe('annotateConflicts', () => {
  test('returns empty array when no conflict markers exist', () => {
    const lines: DiffLine[] = [{ type: 'ctx', text: 'plain' }];
    expect(annotateConflicts(lines)).toEqual([]);
  });
});

describe('buildSections', () => {
  test('auto-collapses large context sections', () => {
    const lines: DiffLine[] = [
      { type: 'ctx', text: 'a' },
      ...Array.from({ length: 10 }, (_, i) => ({ type: 'ctx' as const, text: `ctx-${i}` })),
      { type: 'add', text: 'added' },
    ];

    const sections = buildSections(lines, 2);

    expect(sections.some((s) => s.kind === 'context' && s.collapsed)).toBe(true);
    expect(sections.some((s) => s.kind === 'change')).toBe(true);
  });
});

describe('buildVirtualRows', () => {
  test('inserts hunk header rows at line boundaries', () => {
    const lines: DiffLine[] = [
      { type: 'ctx', text: 'a', oldNo: 1, newNo: 1 },
      { type: 'add', text: 'b', newNo: 2 },
    ];
    const sections = buildSections(lines, 3);
    const hunkHeaders = new Map<number, string>([[0, '@@ -1,1 +1,2 @@']]);

    const rows = buildVirtualRows(sections, lines, hunkHeaders, 3);

    expect(rows[0]).toEqual({ type: 'hunk', text: '@@ -1,1 +1,2 @@', hunkStartIdx: 0 });
    expect(rows.some((r) => r.type === 'line')).toBe(true);
  });

  test('inserts fold rows for collapsed context sections', () => {
    const lines: DiffLine[] = Array.from({ length: 8 }, (_, i) => ({
      type: 'ctx' as const,
      text: `line-${i}`,
      oldNo: i + 1,
      newNo: i + 1,
    }));
    const sections = buildSections(lines, 2);
    const hunkHeaders = new Map<number, string>();

    const rows = buildVirtualRows(sections, lines, hunkHeaders, 2);

    expect(rows.some((r) => r.type === 'fold')).toBe(true);
    expect(rows.some((r) => r.type === 'line')).toBe(true);
  });
});

describe('buildSplitPairs', () => {
  test('pairs deletions and additions on the same side', () => {
    const lines: DiffLine[] = [
      { type: 'del', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'c' },
      { type: 'ctx', text: 'same', oldNo: 1, newNo: 1 },
    ];

    const pairs = buildSplitPairs(lines, 0, lines.length - 1);

    expect(pairs[0]).toEqual({ left: lines[0], right: lines[2] });
    expect(pairs[1]).toEqual({ left: lines[1], right: undefined });
    expect(pairs[2]).toEqual({ left: lines[3], right: lines[3] });
  });
});

describe('buildThreePaneTriples', () => {
  test('maps pure additions to center/right only', () => {
    const lines: DiffLine[] = [{ type: 'add', text: 'new-only', newNo: 1 }];
    const triples = buildThreePaneTriples(lines, 0, 0);

    expect(triples[0]).toEqual({
      left: undefined,
      center: lines[0],
      right: lines[0],
    });
  });

  test('maps replacements to center/right additions', () => {
    const lines: DiffLine[] = [
      { type: 'del', text: 'old' },
      { type: 'add', text: 'new' },
    ];

    const triples = buildThreePaneTriples(lines, 0, 1);

    expect(triples[0]).toEqual({
      left: lines[0],
      center: lines[1],
      right: lines[1],
    });
  });
});

describe('isOneSidedDiff', () => {
  test('git status added/deleted is one-sided regardless of content', () => {
    expect(isOneSidedDiff({ status: 'added' })).toBe(true);
    expect(isOneSidedDiff({ status: 'deleted' })).toBe(true);
    expect(isOneSidedDiff({ status: 'modified' })).toBe(false);
  });

  test('raw diff with only additions is one-sided (created file)', () => {
    const created = ['@@ -0,0 +1,2 @@', '+line one', '+line two'].join('\n');
    expect(isOneSidedDiff({ rawDiff: created })).toBe(true);
  });

  test('raw diff with only deletions is one-sided (deleted file)', () => {
    const deleted = ['@@ -1,2 +0,0 @@', '-line one', '-line two'].join('\n');
    expect(isOneSidedDiff({ rawDiff: deleted })).toBe(true);
  });

  test('raw diff with both adds and dels is two-sided', () => {
    expect(isOneSidedDiff({ rawDiff: SAMPLE_DIFF })).toBe(false);
  });

  test('+++/--- file headers do not count as body changes', () => {
    const headerOnly = ['--- a/x.ts', '+++ b/x.ts', '@@ -0,0 +1,1 @@', '+added'].join('\n');
    expect(isOneSidedDiff({ rawDiff: headerOnly })).toBe(true);
  });

  // Thread Edit/Write cards & end-of-session summary pass no `files` status:
  // fall back to old/new snippet emptiness.
  test('falls back to old/new values when no status or raw diff', () => {
    expect(isOneSidedDiff({ oldValue: '', newValue: 'created content' })).toBe(true);
    expect(isOneSidedDiff({ oldValue: 'removed content', newValue: '' })).toBe(true);
    expect(isOneSidedDiff({ oldValue: 'before', newValue: 'after' })).toBe(false);
    expect(isOneSidedDiff({ oldValue: '', newValue: '' })).toBe(false);
  });
});

describe('search utilities', () => {
  test('escapeRegExp escapes regex metacharacters', () => {
    expect(escapeRegExp('a.b(c)')).toBe('a\\.b\\(c\\)');
  });

  test('countTextMatches is case-insensitive by default', () => {
    expect(countTextMatches('Hello hello HELLO', 'hello')).toBe(3);
  });

  test('countTextMatches returns 0 for empty query', () => {
    expect(countTextMatches('anything', '')).toBe(0);
  });
});
