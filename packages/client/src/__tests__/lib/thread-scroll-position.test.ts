import { describe, expect, test } from 'vitest';

import {
  loadThreadScrollFetchOptions,
  saveThreadScrollPosition,
} from '@/lib/thread-scroll-position';

describe('thread scroll position', () => {
  test('omits stale anchors when the saved position is at the thread bottom', () => {
    saveThreadScrollPosition('bottom-thread', {
      progress: 1,
      anchor: { key: 'm-old-visible-top', offsetFromViewportTop: 20 },
    });

    expect(loadThreadScrollFetchOptions('bottom-thread')).toEqual({
      messageProgress: 1,
    });
  });

  test('keeps anchors for non-bottom saved positions', () => {
    saveThreadScrollPosition('middle-thread', {
      progress: 0.5,
      anchor: { key: 'm-visible', offsetFromViewportTop: 20 },
    });

    expect(loadThreadScrollFetchOptions('middle-thread')).toEqual({
      messageProgress: 0.5,
      messageAnchorId: 'm-visible',
    });
  });
});
