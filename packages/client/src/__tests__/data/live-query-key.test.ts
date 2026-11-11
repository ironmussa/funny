import type { Thread } from '@funny/shared';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';

import { createDataLayer } from '@/data/data-layer';
import { liveQueryKey } from '@/data/live-query-key';
import { replaceDataLayer } from '@/data/runtime';
import { useThreadById } from '@/data/threads/hooks';
import { seedProjectThreads } from '@/data/threads/testing';

import { resetTestDataLayer } from '../helpers/data-layer-harness';

function makeThread(id: string, title: string): Thread {
  return {
    id,
    projectId: 'p1',
    title,
    status: 'idle',
    cost: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as Thread;
}

describe('liveQueryKey', () => {
  afterEach(() => resetTestDataLayer());

  test('names each collection instance, not its Collection ID', () => {
    const a = { id: 'threads:u1:personal' };
    const b = { id: 'threads:u1:personal' };
    expect(liveQueryKey('q', a, 'x')).toEqual(liveQueryKey('q', a, 'x'));
    expect(liveQueryKey('q', a, 'x')).not.toEqual(liveQueryKey('q', b, 'x'));
  });

  test('a mounted hook follows a new data layer for the same user', () => {
    replaceDataLayer(createDataLayer({ userId: 'u1' }));
    seedProjectThreads({ p1: [makeThread('t1', 'old layer')] });
    const { result } = renderHook(() => useThreadById('t1'));
    expect(result.current?.title).toBe('old layer');

    // Same user, so the new threads collection has the same Collection ID.
    act(() => {
      replaceDataLayer(createDataLayer({ userId: 'u1' }));
      seedProjectThreads({ p1: [makeThread('t1', 'new layer')] });
    });
    expect(result.current?.title).toBe('new layer');
  });
});
