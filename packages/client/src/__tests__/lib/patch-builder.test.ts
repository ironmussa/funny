import { describe, test, expect } from 'vitest';

import {
  buildPatchFromSelection,
  getChangeableIndices,
  getHunkChangeableIndices,
  parseRawDiff,
} from '@/lib/patch-builder';

const RAW = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,4 @@',
  ' unchanged',
  '-removed',
  '+added',
  ' tail',
].join('\n');

describe('parseRawDiff', () => {
  test('parses headers, hunks, and line indices', () => {
    const parsed = parseRawDiff(RAW);

    expect(parsed.headerLines).toHaveLength(4);
    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.hunks[0]).toMatchObject({
      oldStart: 1,
      oldCount: 4,
      newStart: 1,
      newCount: 4,
    });
    expect(parsed.allLines).toHaveLength(4);
    expect(parsed.allLines.map((l) => l.type)).toEqual(['ctx', 'del', 'add', 'ctx']);
  });
});

describe('getChangeableIndices', () => {
  test('returns only add/del line indices', () => {
    const parsed = parseRawDiff(RAW);
    const indices = getChangeableIndices(parsed);

    expect(indices.size).toBe(2);
    expect([...indices].sort()).toEqual([1, 2]);
  });
});

describe('getHunkChangeableIndices', () => {
  test('returns indices for a specific hunk only', () => {
    const parsed = parseRawDiff(RAW);

    expect(getHunkChangeableIndices(parsed, 0)).toEqual(getChangeableIndices(parsed));
    expect(getHunkChangeableIndices(parsed, 99).size).toBe(0);
  });
});

describe('buildPatchFromSelection', () => {
  test('includes only selected changes in the patch', () => {
    const parsed = parseRawDiff(RAW);
    const delLine = parsed.allLines.find((l) => l.type === 'del')!;
    const addLine = parsed.allLines.find((l) => l.type === 'add')!;

    const patch = buildPatchFromSelection(parsed, new Set([delLine.index]));

    expect(patch).toContain('-removed');
    expect(patch).not.toContain('+added');
    expect(patch).toContain(' unchanged');
  });

  test('turns unselected deletions into context lines', () => {
    const parsed = parseRawDiff(RAW);
    const addLine = parsed.allLines.find((l) => l.type === 'add')!;

    const patch = buildPatchFromSelection(parsed, new Set([addLine.index]));

    expect(patch).toContain('+added');
    expect(patch).toContain(' removed');
    expect(patch).not.toContain('-removed');
  });

  test('returns empty string when no changes remain', () => {
    const parsed = parseRawDiff(RAW);
    expect(buildPatchFromSelection(parsed, new Set())).toBe('');
  });
});
