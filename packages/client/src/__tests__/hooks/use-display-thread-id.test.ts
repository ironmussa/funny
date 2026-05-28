import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test } from 'vitest';

import { useDisplayThreadId } from '@/hooks/use-display-thread-id';
import { useThreadStore } from '@/stores/thread-store';

const baseThread = {
  id: 't1',
  projectId: 'p1',
  title: 'One',
  status: 'idle' as const,
  cost: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  messages: [],
};

describe('useDisplayThreadId', () => {
  beforeEach(() => {
    useThreadStore.setState({
      selectedThreadId: null,
      threadDataById: {},
      activeThread: null,
    } as any);
  });

  test('returns null when nothing is selected', () => {
    const { result } = renderHook(() => useDisplayThreadId());
    expect(result.current).toBeNull();
  });

  test('keeps previous display id while the new selection is still loading', () => {
    const t1 = { ...baseThread, id: 't1' };
    const t2 = { ...baseThread, id: 't2' };
    useThreadStore.setState({
      selectedThreadId: 't1',
      threadDataById: { t1: t1 as any },
      activeThread: t1 as any,
    } as any);

    const { result, rerender } = renderHook(() => useDisplayThreadId());
    expect(result.current).toBe('t1');

    act(() => {
      useThreadStore.setState({ selectedThreadId: 't2' } as any);
    });
    rerender();
    expect(result.current).toBe('t1');
  });

  test('advances to the selected thread once its payload is in threadDataById', async () => {
    const t1 = { ...baseThread, id: 't1' };
    const t2 = { ...baseThread, id: 't2' };
    useThreadStore.setState({
      selectedThreadId: 't1',
      threadDataById: { t1: t1 as any },
    } as any);

    const { result, rerender } = renderHook(() => useDisplayThreadId());

    act(() => {
      useThreadStore.setState({ selectedThreadId: 't2' } as any);
    });
    rerender();
    expect(result.current).toBe('t1');

    act(() => {
      useThreadStore.setState({
        threadDataById: { t1: t1 as any, t2: t2 as any },
        activeThread: t2 as any,
      } as any);
    });
    rerender();

    await waitFor(() => expect(result.current).toBe('t2'));
  });
});
