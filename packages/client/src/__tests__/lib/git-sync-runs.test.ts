import { describe, expect, test } from 'bun:test';

import { syncRunCounts } from '@/lib/git-sync-runs';

const commit = (hash: string, ...parentHashes: string[]) => ({ hash, parentHashes });

describe('syncRunCounts', () => {
  test("puts a run's size on its newest commit only", () => {
    // c3 -> c2 -> c1 not pushed, c0 pushed.
    const entries = [commit('c3', 'c2'), commit('c2', 'c1'), commit('c1', 'c0'), commit('c0')];
    const counts = syncRunCounts(entries, new Set(['c3', 'c2', 'c1']));
    expect([...counts]).toEqual([['c3', 3]]);
  });

  test('two branches with their own unpushed commits are two runs', () => {
    const entries = [
      commit('a2', 'a1'),
      commit('b1', 'base'),
      commit('a1', 'base'),
      commit('base'),
    ];
    const counts = syncRunCounts(entries, new Set(['a2', 'a1', 'b1']));
    expect(counts.get('a2')).toBe(2);
    expect(counts.get('b1')).toBe(1);
    expect(counts.has('a1')).toBe(false);
  });

  test('a merge counts the commits of both parents once', () => {
    const entries = [
      commit('m', 'x', 'y'),
      commit('x', 'base'),
      commit('y', 'base'),
      commit('base'),
    ];
    expect(syncRunCounts(entries, new Set(['m', 'x', 'y'])).get('m')).toBe(3);
  });

  test('nothing marked, nothing counted', () => {
    expect(syncRunCounts([commit('c1')], new Set()).size).toBe(0);
  });
});
