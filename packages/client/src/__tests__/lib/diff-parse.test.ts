import { describe, test, expect, beforeEach } from 'vitest';

import { parseDiffNew, parseDiffOld } from '@/lib/diff-parse';

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

describe('parseDiffOld/parseDiffNew edge cases', () => {
  test('returns empty string when there are no hunks', () => {
    const headersOnly = 'diff --git a/x b/x\n--- a/x\n+++ b/x';
    expect(parseDiffOld(headersOnly)).toBe('');
    expect(parseDiffNew(headersOnly)).toBe('');
  });
});
