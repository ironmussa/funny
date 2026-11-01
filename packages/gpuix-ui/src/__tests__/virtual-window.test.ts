import { describe, expect, test } from 'bun:test';

import {
  clampWindowStart,
  scrollTargetForPointer,
  shiftedWindowStartForItems,
  windowStartForVisibleRange,
} from '../virtual-range';

describe('virtual window', () => {
  test('clamps a retained window when the collection shrinks', () => {
    expect(clampWindowStart(900, 120, 48)).toBe(72);
    expect(clampWindowStart(-20, 120, 48)).toBe(0);
  });

  test('moves only when the visible range reaches the retained buffer', () => {
    expect(
      windowStartForVisibleRange({
        currentStart: 100,
        itemCount: 1_000,
        windowSize: 48,
        buffer: 12,
        visibleStart: 116,
        visibleEnd: 132,
      }),
    ).toBe(100);
    expect(
      windowStartForVisibleRange({
        currentStart: 100,
        itemCount: 1_000,
        windowSize: 48,
        buffer: 12,
        visibleStart: 136,
        visibleEnd: 148,
      }),
    ).toBe(124);
  });

  test('preserves the anchored item when rows are prepended or a loader disappears', () => {
    const previous = [{ key: 'load-older' }, { key: 'message-10' }, { key: 'message-11' }];
    const prepended = [
      { key: 'load-older' },
      { key: 'message-8' },
      { key: 'message-9' },
      { key: 'message-10' },
      { key: 'message-11' },
    ];
    const finalPage = [
      { key: 'message-6' },
      { key: 'message-7' },
      { key: 'message-8' },
      { key: 'message-9' },
      { key: 'message-10' },
      { key: 'message-11' },
    ];

    expect(shiftedWindowStartForItems(1, previous, prepended)).toBe(3);
    expect(shiftedWindowStartForItems(3, prepended, finalPage)).toBe(4);
    expect(shiftedWindowStartForItems(1, previous, previous.slice(1))).toBe(0);
  });

  test('maps a scrollbar pointer to the proportional item and offset', () => {
    const track = { trackTop: 100, trackHeight: 400, itemCount: 200, estimatedItemHeight: 20 };

    expect(scrollTargetForPointer({ ...track, pointerY: 100 })).toEqual({
      index: 0,
      offsetInItem: 0,
    });
    expect(scrollTargetForPointer({ ...track, pointerY: 301 })).toEqual({
      index: 100,
      offsetInItem: 10,
    });
    // Past either end of the track clamps to the first item / into the last one.
    expect(scrollTargetForPointer({ ...track, pointerY: -50 })).toEqual({
      index: 0,
      offsetInItem: 0,
    });
    expect(scrollTargetForPointer({ ...track, pointerY: 900 })).toEqual({
      index: 199,
      offsetInItem: 20,
    });
  });

  test('has no scrollbar target for an empty list or a collapsed track', () => {
    const base = { pointerY: 10, trackTop: 0, estimatedItemHeight: 20 };
    expect(scrollTargetForPointer({ ...base, trackHeight: 300, itemCount: 0 })).toBeNull();
    expect(scrollTargetForPointer({ ...base, trackHeight: 0, itemCount: 10 })).toBeNull();
  });
});
