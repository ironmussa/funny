import { describe, expect, test } from 'vitest';

import { computeUnifiedDiff } from '@/lib/snippet-unified-diff';

describe('computeUnifiedDiff', () => {
  test('keeps up to 3 context lines around the changed middle', () => {
    const oldValue = ['a', 'b', 'c', 'd', 'old', 'e', 'f', 'g', 'h'].join('\n');
    const newValue = ['a', 'b', 'c', 'd', 'new1', 'new2', 'e', 'f', 'g', 'h'].join('\n');
    expect(computeUnifiedDiff(oldValue, newValue).split('\n')).toEqual([
      '--- a/file',
      '+++ b/file',
      '@@ -2,7 +2,8 @@',
      ' b',
      ' c',
      ' d',
      '-old',
      '+new1',
      '+new2',
      ' e',
      ' f',
      ' g',
    ]);
  });

  test('offsets the hunk header by the snippet base line', () => {
    expect(computeUnifiedDiff('x', 'y', 40)).toBe(
      '--- a/file\n+++ b/file\n@@ -40,1 +40,1 @@\n-x\n+y',
    );
  });

  test('handles pure additions and identical input', () => {
    expect(computeUnifiedDiff('', 'added')).toBe(
      '--- a/file\n+++ b/file\n@@ -1,1 +1,1 @@\n-\n+added',
    );
    expect(computeUnifiedDiff('same', 'same')).toBe(
      '--- a/file\n+++ b/file\n@@ -1,1 +1,1 @@\n same',
    );
  });
});
