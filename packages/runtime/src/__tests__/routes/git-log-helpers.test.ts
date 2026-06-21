import { describe, test, expect } from 'vitest';

import { buildLogPayload, parseLogPagingFrom } from '../../routes/git/log.js';

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
