import { describe, test, expect } from 'vitest';

import type { DiffLine } from '@/lib/diff-math';
import { injectWordDiffMarks } from '@/lib/diff/highlight';
import { annotateWordDiff, computeWordDiff } from '@/lib/diff/word-diff';

describe('computeWordDiff', () => {
  test('isolates the single changed token', () => {
    const { del, add } = computeWordDiff('const x = 1', 'const x = 2');
    // "1" / "2" both sit at char offset 10.
    expect(del).toEqual([[10, 11]]);
    expect(add).toEqual([[10, 11]]);
  });

  test('reports an inserted token only on the add side', () => {
    const { del, add } = computeWordDiff('foo(a)', 'foo(a, b)');
    expect(del).toEqual([]); // nothing removed from the old line
    expect(add.length).toBeGreaterThan(0); // ", b" highlighted on the new line
    // The highlighted range must fall after "foo(a".
    expect(add[0][0]).toBeGreaterThanOrEqual(5);
  });

  test('returns no ranges for identical text', () => {
    expect(computeWordDiff('same', 'same')).toEqual({ del: [], add: [] });
  });

  test('returns no ranges when nothing is shared (whole-line rewrite)', () => {
    expect(computeWordDiff('aaa', 'zzz')).toEqual({ del: [], add: [] });
  });

  test('returns no ranges for an empty side', () => {
    expect(computeWordDiff('', 'new')).toEqual({ del: [], add: [] });
    expect(computeWordDiff('old', '')).toEqual({ del: [], add: [] });
  });
});

describe('annotateWordDiff', () => {
  function lines(): DiffLine[] {
    return [
      { type: 'ctx', text: 'unchanged', oldNo: 1, newNo: 1 },
      { type: 'del', text: 'const x = 1', oldNo: 2 },
      { type: 'add', text: 'const x = 2', newNo: 2 },
    ];
  }

  test('attaches segments to the paired del/add lines only', () => {
    const ls = lines();
    annotateWordDiff(ls);
    expect(ls[0].segments).toBeUndefined();
    expect(ls[1].segments).toEqual([[10, 11]]);
    expect(ls[2].segments).toEqual([[10, 11]]);
  });

  test('leaves pure additions (no paired deletion) unannotated', () => {
    const ls: DiffLine[] = [{ type: 'add', text: 'brand new line', newNo: 1 }];
    annotateWordDiff(ls);
    expect(ls[0].segments).toBeUndefined();
  });
});

describe('injectWordDiffMarks', () => {
  test('wraps the changed range in a classed span', () => {
    const out = injectWordDiffMarks('const x = 1', [[10, 11]], 'diff-word-add');
    expect(out).toBe('const x = <span class="diff-word-add">1</span>');
  });

  test('counts an HTML entity as a single raw character', () => {
    // raw text "a < b" → offsets a=0, ' '=1, '<'=2, ' '=3, b=4
    const out = injectWordDiffMarks('a &lt; b', [[2, 3]], 'w');
    expect(out).toBe('a <span class="w">&lt;</span> b');
  });

  test('does not touch text inside tags', () => {
    const out = injectWordDiffMarks('<span class="hljs-x">1</span>', [[0, 1]], 'w');
    expect(out).toBe('<span class="hljs-x"><span class="w">1</span></span>');
  });

  test('returns the html unchanged when there are no segments', () => {
    expect(injectWordDiffMarks('abc', [], 'w')).toBe('abc');
  });
});
