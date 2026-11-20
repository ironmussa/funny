import type { BranchPRInfo } from '@funny/core/git';
import { describe, test, expect } from 'vitest';

import { buildLogPayload, parseLogPagingFrom, refsToHide } from '../../routes/git/log.js';

// These pure helpers back every project- and thread-scoped log endpoint. The
// handlers over-read by one entry (`limit + 1`) to compute `hasMore` cheaply,
// then shape the response through buildLogPayload — so both the project and
// thread variants stay byte-for-byte identical. The regression these guard
// against: the look-ahead entry leaking into `entries`, or `unpushedHashes`
// including hashes outside the returned window.

function entry(hash: string) {
  return { hash, shortHash: hash.slice(0, 7), message: `commit ${hash}` };
}

describe('parseLogPagingFrom', () => {
  test('applies defaults when both params are absent', () => {
    expect(parseLogPagingFrom(undefined, undefined)).toEqual({ limit: 50, skip: 0 });
  });

  test('caps limit at 200', () => {
    expect(parseLogPagingFrom('5000', undefined).limit).toBe(200);
  });

  test('falls back to 20 for an unparseable limit', () => {
    expect(parseLogPagingFrom('abc', undefined).limit).toBe(20);
  });

  test('floors skip at 0', () => {
    expect(parseLogPagingFrom(undefined, '-10').skip).toBe(0);
  });

  test('passes through valid values', () => {
    expect(parseLogPagingFrom('30', '60')).toEqual({ limit: 30, skip: 60 });
  });
});

describe('buildLogPayload', () => {
  test('trims the look-ahead entry and reports hasMore when over-read', () => {
    // limit=2 but 3 entries returned (the +1 look-ahead) → hasMore, 2 entries.
    const entries = [entry('a'), entry('b'), entry('c')];
    const payload = buildLogPayload(entries, new Set(), new Set(), 2);
    expect(payload.hasMore).toBe(true);
    expect(payload.entries.map((e) => e.hash)).toEqual(['a', 'b']);
  });

  test('hasMore is false when the result fits within the limit', () => {
    const entries = [entry('a'), entry('b')];
    const payload = buildLogPayload(entries, new Set(), new Set(), 5);
    expect(payload.hasMore).toBe(false);
    expect(payload.entries).toHaveLength(2);
  });

  test('projects only unpushed hashes that fall within the returned window', () => {
    // 'c' is unpushed but gets trimmed off as the look-ahead entry, so it must
    // not appear in unpushedHashes — only 'a' (within the window) survives.
    const entries = [entry('a'), entry('b'), entry('c')];
    const payload = buildLogPayload(entries, new Set(['a', 'c']), new Set(), 2);
    expect(payload.unpushedHashes).toEqual(['a']);
  });

  test('projects only unpulled hashes that fall within the returned window', () => {
    const entries = [entry('a'), entry('b'), entry('c')];
    const payload = buildLogPayload(entries, new Set(), new Set(['b', 'c']), 2);
    expect(payload.unpulledHashes).toEqual(['b']);
  });

  test('returns an empty unpushed list when the set is empty', () => {
    const payload = buildLogPayload([entry('a')], new Set(), new Set(), 50);
    expect(payload.unpushedHashes).toEqual([]);
    expect(payload.unpulledHashes).toEqual([]);
  });

  test('handles an empty log', () => {
    expect(buildLogPayload([], new Set(['x']), new Set(['x']), 50)).toEqual({
      entries: [],
      hasMore: false,
      unpushedHashes: [],
      unpulledHashes: [],
    });
  });
});

describe('refsToHide', () => {
  const merged: BranchPRInfo = {
    prNumber: 7,
    prUrl: 'https://github.com/o/r/pull/7',
    prState: 'MERGED',
  };
  const open: BranchPRInfo = {
    prNumber: 8,
    prUrl: 'https://github.com/o/r/pull/8',
    prState: 'OPEN',
  };
  const prs: Record<string, BranchPRInfo | null> = {
    'factory/issue-1': merged,
    'feat/open': open,
    'funny/factory-1-alias': null,
    main: null,
  };
  const prOf = (branch: string) => prs[branch];

  test('hides a branch without a PR of its own that points at a merged branch', () => {
    const refs = [
      { ref: 'refs/heads/factory/issue-1', tip: 'aaa' },
      { ref: 'refs/heads/funny/factory-1-alias', tip: 'aaa' },
    ];
    expect(refsToHide(refs, prOf, 'main')).toEqual([
      'refs/heads/factory/issue-1',
      'refs/heads/funny/factory-1-alias',
    ]);
  });

  test('keeps an alias at another commit, one with its own open PR, and one not looked up yet', () => {
    const refs = [
      { ref: 'refs/heads/factory/issue-1', tip: 'aaa' },
      { ref: 'refs/heads/funny/factory-1-alias', tip: 'bbb' },
      { ref: 'refs/heads/feat/open', tip: 'aaa' },
      { ref: 'refs/heads/feat/never-looked-up', tip: 'aaa' },
    ];
    expect(refsToHide(refs, prOf, 'main')).toEqual(['refs/heads/factory/issue-1']);
  });

  test('never hides the base branch, even at the tip of a merged branch', () => {
    // A fast-forward merge leaves the base branch at the merged branch's tip.
    const refs = [
      { ref: 'refs/heads/main', tip: 'aaa' },
      { ref: 'refs/remotes/origin/main', tip: 'aaa' },
      { ref: 'refs/heads/factory/issue-1', tip: 'aaa' },
    ];
    expect(refsToHide(refs, prOf, 'main')).toEqual(['refs/heads/factory/issue-1']);
  });
});
