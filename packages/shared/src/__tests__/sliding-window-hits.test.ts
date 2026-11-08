import { describe, expect, test } from 'bun:test';

import { pruneSlidingWindowHits } from '../lib/sliding-window-hits.js';

describe('pruneSlidingWindowHits', () => {
  test('keeps timestamps inside the window and deletes keys left empty', () => {
    const hits = new Map<string, number[]>([
      ['fresh', [950, 990]],
      ['mixed', [100, 960]],
      ['stale', [100, 200]],
    ]);

    pruneSlidingWindowHits(hits, 100, 1000);

    expect(hits.get('fresh')).toEqual([950, 990]);
    expect(hits.get('mixed')).toEqual([960]);
    expect(hits.has('stale')).toBe(false);
  });
});
