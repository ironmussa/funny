import { describe, test, expect } from 'vitest';

import { countDiffStats, parseDiffNew, parseDiffOld } from '@/lib/diff-parse';

const unified = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' unchanged',
  '-removed',
  '+added',
  ' tail',
].join('\n');

describe('parseDiffOld', () => {
  test('skips headers and reconstructs the left side', () => {
    expect(parseDiffOld(unified)).toBe(['unchanged', 'removed', 'tail'].join('\n'));
  });
});

describe('parseDiffNew', () => {
  test('skips headers and reconstructs the right side', () => {
    expect(parseDiffNew(unified)).toBe(['unchanged', 'added', 'tail'].join('\n'));
  });
});

describe('countDiffStats', () => {
  test('counts added/removed lines, ignoring headers', () => {
    expect(countDiffStats(unified)).toEqual({ additions: 1, deletions: 1 });
  });

  test('sums across concatenated per-edit diffs (session fallback format)', () => {
    const concatenated = [
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,2 @@',
      '-one',
      '+uno',
      '+dos',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -5,1 +5,1 @@',
      '-five',
      '+cinco',
    ].join('\n');
    expect(countDiffStats(concatenated)).toEqual({ additions: 3, deletions: 2 });
  });

  test('returns zeros when there are no hunks', () => {
    expect(countDiffStats('diff --git a/x b/x\n--- a/x\n+++ b/x')).toEqual({
      additions: 0,
      deletions: 0,
    });
  });
});

describe('parseDiffOld/parseDiffNew edge cases', () => {
  test('returns empty string when there are no hunks', () => {
    const headersOnly = 'diff --git a/x b/x\n--- a/x\n+++ b/x';
    expect(parseDiffOld(headersOnly)).toBe('');
    expect(parseDiffNew(headersOnly)).toBe('');
  });
});
