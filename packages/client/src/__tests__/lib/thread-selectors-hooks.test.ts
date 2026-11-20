import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, test } from 'vitest';

import { buildThread, withThreadIndex } from '@/data/threads/testing';
import {
  useScratchThreads,
  useThreadById,
  useThreadsByProject,
  useThreadsForProject,
} from '@/lib/thread-selectors';
import { useThreadStore } from '@/stores/thread-store';

function makeThread(id: string, projectId = 'p1') {
  return buildThread({ id, projectId, title: id, status: 'idle' });
}

describe('thread-selectors hooks', () => {
  beforeEach(() => {
    useThreadStore.setState(
      withThreadIndex({
        threadsById: {},
        threadIdsByProject: {},
        scratchThreadIds: [],
        threadTotalByProject: {},
        scratchThreadTotal: 0,
        selectedThreadId: null,
        threadDataById: {},
        activeThread: null,
        setupProgressByThread: {},
      }),
    );
  });

  test('useThreadById returns undefined for null id', () => {
    const { result } = renderHook(() => useThreadById(null));
    expect(result.current).toBeUndefined();
  });

  test('useThreadById reacts to store updates', () => {
    const t1 = makeThread('t1');
    useThreadStore.setState(
      withThreadIndex({
        threadsById: { t1: t1 },
      }),
    );

    const { result } = renderHook(() => useThreadById('t1'));
    expect(result.current?.title).toBe('t1');
  });

  test('useThreadsForProject returns ordered project threads', () => {
    const t1 = makeThread('t1');
    const t2 = makeThread('t2');
    useThreadStore.setState(
      withThreadIndex({
        threadsById: { t1: t1, t2: t2 },
        threadIdsByProject: { p1: ['t1', 't2'] },
      }),
    );

    const { result } = renderHook(() => useThreadsForProject('p1'));
    expect(result.current.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  test('useScratchThreads returns scratch bucket', () => {
    const s1 = { ...makeThread('s1', ''), isScratch: true };
    useThreadStore.setState(
      withThreadIndex({
        threadsById: { s1: s1 },
        scratchThreadIds: ['s1'],
      }),
    );

    const { result } = renderHook(() => useScratchThreads());
    expect(result.current).toHaveLength(1);
    expect(result.current[0].id).toBe('s1');
  });

  test('useThreadsByProject exposes all loaded project buckets', () => {
    const t1 = makeThread('t1', 'p1');
    const t2 = makeThread('t2', 'p2');
    useThreadStore.setState(
      withThreadIndex({
        threadsById: { t1: t1, t2: t2 },
        threadIdsByProject: { p1: ['t1'], p2: ['t2'] },
      }),
    );

    const { result } = renderHook(() => useThreadsByProject());
    expect(Object.keys(result.current).sort()).toEqual(['p1', 'p2']);
    expect(result.current.p1[0].id).toBe('t1');
  });
});
