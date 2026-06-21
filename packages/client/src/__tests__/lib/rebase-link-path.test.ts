import { describe, expect, test } from 'vitest';

import { rebaseCopyLinkRailX, roundedRebaseCopyLinkPath } from '@/lib/rebase-link-path';

describe('rebase-link-path', () => {
  test('keeps every rebase copy link on the same single rail', () => {
    const railXs = [0, 1, 2].map(() =>
      rebaseCopyLinkRailX({
        laneGutterWidth: 48,
        railWidth: 32,
      }),
    );

    expect(railXs).toEqual([76, 76, 76]);
  });

  test('routes rebase copy links as straight dashed segments with rounded corners', () => {
    const path = roundedRebaseCopyLinkPath({
      sourceX: 50,
      sourceY: 100,
      targetX: 40,
      targetY: 20,
      railX: 90,
      radius: 8,
    });

    expect(path).toBe('M 50 100 L 82 100 Q 90 100 90 92 L 90 28 Q 90 20 82 20 L 40 20');
    expect(path).not.toContain(' C ');
  });
});
