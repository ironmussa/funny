import { describe, expect, test } from 'vitest';

import {
  rebaseCopyLinkRailLane,
  rebaseCopyLinkRailX,
  rebaseCopyLinkUsesOuterRail,
  roundedRebaseCopyLinkPath,
} from '@/lib/rebase-link-path';

describe('rebase-link-path', () => {
  test('keeps every rebase copy link on the same single rail', () => {
    const railXs = [0, 1, 2].map(() =>
      rebaseCopyLinkRailX({
        laneGutterWidth: 48,
        railWidth: 16,
      }),
    );

    expect(railXs).toEqual([68, 68, 68]);
  });

  test('places a rebase rail one lane outside the linked nodes', () => {
    expect(rebaseCopyLinkRailLane({ sourceLane: 0, targetLane: 0 })).toBe(1);
    expect(rebaseCopyLinkRailLane({ sourceLane: 2, targetLane: 0 })).toBe(3);
    expect(rebaseCopyLinkRailLane({ sourceLane: null, targetLane: 1 })).toBe(2);
  });

  test('only reserves outer gutter width when the local rail exceeds normal lanes', () => {
    expect(rebaseCopyLinkUsesOuterRail({ sourceLane: 0, targetLane: 0, laneCount: 3 })).toBe(false);
    expect(rebaseCopyLinkUsesOuterRail({ sourceLane: 1, targetLane: 2, laneCount: 3 })).toBe(true);
  });

  test('routes rebase copy links like graph branch lines with rounded corners', () => {
    const path = roundedRebaseCopyLinkPath({
      sourceX: 50,
      sourceY: 100,
      targetX: 40,
      targetY: 20,
      railX: 90,
    });

    expect(path).toBe('M 50 100 L 82 100 Q 90 100 90 92 L 90 28 Q 90 20 82 20 L 40 20');
    expect(path).toContain(' Q ');
    expect(path).not.toContain(' C ');
  });
});
