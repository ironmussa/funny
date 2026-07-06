import { describe, expect, test } from 'vitest';

import {
  getFirstMessageId,
  getLastMessage,
  getLastUserMessageId,
  getLastVisibleUserMessageId,
  getLocalScrollProgress,
  getThreadScrollProgress,
} from '@/components/thread/message-stream-scroll-utils';

function makeViewport({
  clientHeight,
  scrollHeight,
  scrollTop,
}: {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}) {
  const viewport = document.createElement('div');
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: clientHeight });
  Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: scrollHeight });
  viewport.scrollTop = scrollTop;
  return viewport;
}

describe('message stream scroll utilities', () => {
  test('maps local scroll progress to full thread progress for paginated windows', () => {
    const viewport = makeViewport({
      clientHeight: 100,
      scrollHeight: 500,
      scrollTop: 200,
    });

    const threadProgress = getThreadScrollProgress(viewport, {
      hasPagination: true,
      loadedCount: 3,
      paginationTotal: 10,
      paginationWindowStart: 3,
    });

    expect(threadProgress).toBeCloseTo(4 / 9);
    expect(
      getLocalScrollProgress(threadProgress, {
        hasPagination: true,
        loadedCount: 3,
        paginationTotal: 10,
        paginationWindowStart: 3,
      }),
    ).toBeCloseTo(0.5);
  });

  test('uses viewport progress when pagination metadata is unavailable', () => {
    const viewport = makeViewport({
      clientHeight: 100,
      scrollHeight: 500,
      scrollTop: 100,
    });

    expect(
      getThreadScrollProgress(viewport, {
        hasPagination: false,
        loadedCount: 0,
      }),
    ).toBe(0.25);
    expect(
      getLocalScrollProgress(1.5, {
        hasPagination: false,
        loadedCount: 0,
      }),
    ).toBe(1);
  });

  test('selects message ids needed by scroll restoration', () => {
    const messages = [
      { id: 'u1', role: 'user', content: 'first' },
      { id: 'a1', role: 'assistant', content: 'reply' },
      { id: 'u2', role: 'user', content: 'latest visible' },
      { id: 'u3', role: 'user', content: '   ' },
    ];

    expect(getFirstMessageId(messages)).toBe('u1');
    expect(getLastMessage(messages)?.id).toBe('u3');
    expect(getLastUserMessageId(messages)).toBe('u3');
    expect(getLastVisibleUserMessageId(messages)).toBe('u2');
  });
});
