import { afterEach, describe, expect, test, vi } from 'bun:test';

import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';

import { buildThreadWithMessages } from '@/data/threads/testing';
import { useActiveThreadId } from '@/hooks/use-active-thread-id';
import { useActiveThreadData, useThreadData } from '@/hooks/use-thread-data';
import { useThreadStore } from '@/stores/thread-store';

function wrapperFor(route: string) {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
  );
}

describe('useActiveThreadId', () => {
  test('derives id from a project thread route', () => {
    const { result } = renderHook(() => useActiveThreadId(), {
      wrapper: wrapperFor('/projects/p1/threads/t1'),
    });
    expect(result.current).toBe('t1');
  });

  test('derives id from a scratch thread route', () => {
    const { result } = renderHook(() => useActiveThreadId(), {
      wrapper: wrapperFor('/scratch/s1'),
    });
    expect(result.current).toBe('s1');
  });

  test('null on a non-thread route', () => {
    const { result } = renderHook(() => useActiveThreadId(), {
      wrapper: wrapperFor('/projects/p1'),
    });
    expect(result.current).toBeNull();
  });

  test('null on /scratch/new (compose, not a thread)', () => {
    const { result } = renderHook(() => useActiveThreadId(), {
      wrapper: wrapperFor('/scratch/new'),
    });
    expect(result.current).toBeNull();
  });

  test('honors the org-slug prefix', () => {
    const { result } = renderHook(() => useActiveThreadId(), {
      wrapper: wrapperFor('/acme/projects/p1/threads/t1'),
    });
    expect(result.current).toBe('t1');
  });
});

describe('useThreadData / useActiveThreadData', () => {
  const t1 = buildThreadWithMessages();

  afterEach(() => {
    vi.restoreAllMocks();
    // The hook is still mounted here (cleanup runs after this hook).
    act(() => useThreadStore.setState({ threadDataById: {} }));
  });

  test('useThreadData returns the cached payload by id', () => {
    useThreadStore.setState({ threadDataById: { t1 } });
    const { result } = renderHook(() => useThreadData('t1'), { wrapper: wrapperFor('/') });
    expect(result.current).toEqual(t1);
  });

  test('useThreadData returns null for an unloaded id', () => {
    useThreadStore.setState({ threadDataById: {} });
    const { result } = renderHook(() => useThreadData('missing'), { wrapper: wrapperFor('/') });
    expect(result.current).toBeNull();
  });

  test('useThreadData returns null for a null id', () => {
    const { result } = renderHook(() => useThreadData(null), { wrapper: wrapperFor('/') });
    expect(result.current).toBeNull();
  });

  test('useActiveThreadData resolves the URL thread from the cache', () => {
    useThreadStore.setState({ threadDataById: { t1 } });
    const { result } = renderHook(() => useActiveThreadData(), {
      wrapper: wrapperFor('/projects/p1/threads/t1'),
    });
    expect(result.current).toEqual(t1);
  });

  test('useActiveThreadData is null when URL thread is not yet cached', () => {
    useThreadStore.setState({ threadDataById: {} });
    const { result } = renderHook(() => useActiveThreadData(), {
      wrapper: wrapperFor('/projects/p1/threads/t1'),
    });
    expect(result.current).toBeNull();
  });
});
