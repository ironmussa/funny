import { afterEach, describe, expect, test, vi } from 'bun:test';

import {
  createRowEstimateCache,
  getRowBottomFromRenderedOffset,
  type FontConfig,
} from '@/components/thread/MemoizedMessageList.measurement';
import type { VirtualRow } from '@/components/thread/MemoizedMessageList.virtualRows';

describe('getRowBottomFromRenderedOffset', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  function mountRow(offset?: string) {
    const row = document.createElement('div');
    if (offset !== undefined) row.dataset.rowOffset = offset;
    document.body.appendChild(row);
    return row;
  }

  test('adds the measured height to the offset the row was rendered at', () => {
    expect(getRowBottomFromRenderedOffset(mountRow('120'), 40)).toBe(160);
  });

  test('reads no layout, so measuring a row cannot force a reflow', () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    getRowBottomFromRenderedOffset(mountRow('0'), 40);
    expect(rectSpy).not.toHaveBeenCalled();
  });

  test('returns undefined for a detached row or a row without an offset', () => {
    const detached = document.createElement('div');
    detached.dataset.rowOffset = '10';
    expect(getRowBottomFromRenderedOffset(detached, 40)).toBeUndefined();
    expect(getRowBottomFromRenderedOffset(mountRow(), 40)).toBeUndefined();
  });
});

describe('createRowEstimateCache', () => {
  const fonts: FontConfig = {
    proseFont: '14px sans-serif',
    proseLineHeight: 20,
    codeLineHeight: 18,
  };
  const NARROW = 248;
  const WIDE = 1064;

  // Six attachments wrap into three rows in a narrow list and one in a wide
  // one, so the fresh estimate depends on the width. The width stands in for
  // anything that changes a fresh estimate while the layout key stays the
  // same, as pretext does once it has prepared a text.
  function userRow(content = 'look at these'): VirtualRow {
    const msg = { id: 'u1', role: 'user', content, images: Array.from({ length: 6 }, () => ({})) };
    return { type: 'item', key: 'u1', itemIndex: 0, item: { type: 'message', msg } as never };
  }

  test('keeps a row estimate from one render to the next', () => {
    const cache = createRowEstimateCache();
    const first = cache.estimate(userRow(), NARROW, fonts, 'layout');
    const fresh = createRowEstimateCache().estimate(userRow(), WIDE, fonts, 'layout');

    expect(fresh).not.toBe(first);
    expect(cache.estimate(userRow(), WIDE, fonts, 'layout')).toBe(first);
  });

  test('estimates again when the layout changes', () => {
    const cache = createRowEstimateCache();
    const first = cache.estimate(userRow(), NARROW, fonts, 'narrow');

    expect(cache.estimate(userRow(), WIDE, fonts, 'wide')).not.toBe(first);
  });

  test('estimates again when the row content changes', () => {
    const cache = createRowEstimateCache();
    const first = cache.estimate(userRow(), NARROW, fonts, 'layout');

    expect(cache.estimate(userRow('look at these, please'), WIDE, fonts, 'layout')).not.toBe(first);
  });

  test('estimates again after clear', () => {
    const cache = createRowEstimateCache();
    const first = cache.estimate(userRow(), NARROW, fonts, 'layout');
    cache.clear();

    expect(cache.estimate(userRow(), WIDE, fonts, 'layout')).not.toBe(first);
  });
});
