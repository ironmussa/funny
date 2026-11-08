import { afterEach, describe, expect, test, vi } from 'vitest';

import { getRowBottomFromRenderedOffset } from '@/components/thread/MemoizedMessageList.measurement';

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
