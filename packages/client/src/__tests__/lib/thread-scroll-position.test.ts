import { beforeEach, describe, expect, test } from 'vitest';

import {
  __resetThreadScrollPositionForTests,
  loadThreadScrollFetchOptions,
  saveThreadScrollPosition,
} from '@/lib/thread-scroll-position';

describe('thread scroll position', () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetThreadScrollPositionForTests();
  });

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

  test('keeps only the most recent saved thread positions', () => {
    for (let index = 0; index < 205; index++) {
      saveThreadScrollPosition(`thread-${index}`, {
        progress: 0.5,
        anchor: { key: `m-${index}`, offsetFromViewportTop: 20 },
      });
    }

    expect(loadThreadScrollFetchOptions('thread-0')).toEqual({});
    expect(loadThreadScrollFetchOptions('thread-4')).toEqual({});
    expect(loadThreadScrollFetchOptions('thread-5')).toEqual({
      messageProgress: 0.5,
      messageAnchorId: 'm-5',
    });
    expect(loadThreadScrollFetchOptions('thread-204')).toEqual({
      messageProgress: 0.5,
      messageAnchorId: 'm-204',
    });
  });
});
