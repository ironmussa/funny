import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, test } from 'vitest';

import {
  useScratchThreads,
  useThreadById,
  useThreadsByProject,
  useThreadsForProject,
} from '@/lib/thread-selectors';
import { useThreadStore } from '@/stores/thread-store';

function makeThread(id: string, projectId = 'p1') {
  return {
    id,
    projectId,
    title: id,
    status: 'idle' as const,
    cost: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('thread-selectors hooks', () => {
  beforeEach(() => {
    useThreadStore.setState({
      threadsById: {},
      threadIdsByProject: {},
      scratchThreadIds: [],
      threadTotalByProject: {},
      scratchThreadTotal: 0,
      selectedThreadId: null,
      threadDataById: {},
      activeThread: null,
      setupProgressByThread: {},
      contextUsageByThread: {},
      queuedCountByThread: {},
    } as any);
  });

  test('useThreadById returns undefined for null id', () => {
    const { result } = renderHook(() => useThreadById(null));
    expect(result.current).toBeUndefined();
  });

  test('useThreadById reacts to store updates', () => {
    const t1 = makeThread('t1');
    useThreadStore.setState({
      threadsById: { t1: t1 as any },
    } as any);

    const { result } = renderHook(() => useThreadById('t1'));
    expect(result.current?.title).toBe('t1');
  });

  test('useThreadsForProject returns ordered project threads', () => {
    const t1 = makeThread('t1');
    const t2 = makeThread('t2');
    useThreadStore.setState({
      threadsById: { t1: t1 as any, t2: t2 as any },
      threadIdsByProject: { p1: ['t1', 't2'] },
    } as any);

    const { result } = renderHook(() => useThreadsForProject('p1'));
    expect(result.current.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  test('useScratchThreads returns scratch bucket', () => {
    const s1 = { ...makeThread('s1', ''), isScratch: true };
    useThreadStore.setState({
      threadsById: { s1: s1 as any },
      scratchThreadIds: ['s1'],
    } as any);

    const { result } = renderHook(() => useScratchThreads());
    expect(result.current).toHaveLength(1);
    expect(result.current[0].id).toBe('s1');
  });

  test('useThreadsByProject exposes all loaded project buckets', () => {
    const t1 = makeThread('t1', 'p1');
    const t2 = makeThread('t2', 'p2');
    useThreadStore.setState({
      threadsById: { t1: t1 as any, t2: t2 as any },
      threadIdsByProject: { p1: ['t1'], p2: ['t2'] },
    } as any);

    const { result } = renderHook(() => useThreadsByProject());
    expect(Object.keys(result.current).sort()).toEqual(['p1', 'p2']);
    expect(result.current.p1[0].id).toBe('t1');
  });
});
