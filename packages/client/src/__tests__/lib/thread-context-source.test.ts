import { afterEach, describe, expect, test } from 'vitest';

import { threadContextHeaders, urlInThread } from '@/lib/api/_core';
import { toRawFileSrc } from '@/lib/raw-file-src';
import { openThreadId } from '@/lib/thread-context-source';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

function openThread(id: string | null) {
  useThreadStore.setState({ activeThread: id ? ({ id, messages: [] } as any) : null });
}

afterEach(() => {
  openThread(null);
  useUIStore.setState({ liveColumnsOpen: false, gridSelectedThreadId: null });
});

describe('thread context', () => {
  test('outside a thread, requests carry no thread', () => {
    expect(openThreadId()).toBeNull();
    expect(threadContextHeaders()).toEqual({});
    expect(urlInThread('/api/files/raw?path=%2Fa.png')).toBe('/api/files/raw?path=%2Fa.png');
  });

  test('the open thread names where the workspace requests run', () => {
    openThread('t-box');
    expect(threadContextHeaders()).toEqual({ 'X-Funny-Thread-Id': 't-box' });
    // Raw files load by URL (no headers), so the thread rides in the query.
    expect(toRawFileSrc('/repo/shot.png')).toBe(
      '/api/files/raw?path=%2Frepo%2Fshot.png&threadId=t-box',
    );
  });

  test('in live columns, the selected column is the open thread', () => {
    openThread('t-stale');
    useUIStore.setState({ liveColumnsOpen: true, gridSelectedThreadId: 't-grid' });
    expect(openThreadId()).toBe('t-grid');
    useUIStore.setState({ gridSelectedThreadId: null });
    expect(openThreadId()).toBeNull();
  });
});
