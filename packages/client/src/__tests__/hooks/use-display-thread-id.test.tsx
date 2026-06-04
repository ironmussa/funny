import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
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

function renderAt(route: string) {
  return renderHook(
    () => {
      const navigate = useNavigate();
      const display = useDisplayThreadId();
      return { navigate, display };
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
      ),
    },
  );
}

describe('useDisplayThreadId', () => {
  beforeEach(() => {
    useThreadStore.setState({ threadDataById: {}, activeThread: null } as any);
  });

  test('returns null on a non-thread route', () => {
    const { result } = renderAt('/');
    expect(result.current.display).toBeNull();
  });

  test('keeps the previous display id while the new URL thread is still loading', async () => {
    useThreadStore.setState({ threadDataById: { t1: { ...baseThread, id: 't1' } } } as any);
    const { result } = renderAt('/projects/p1/threads/t1');
    await waitFor(() => expect(result.current.display).toBe('t1'));

    // Navigate to t2, whose payload isn't loaded yet → display stays on t1.
    act(() => result.current.navigate('/projects/p1/threads/t2'));
    expect(result.current.display).toBe('t1');
  });

  test('advances to the URL thread once its payload is in threadDataById', async () => {
    useThreadStore.setState({ threadDataById: { t1: { ...baseThread, id: 't1' } } } as any);
    const { result } = renderAt('/projects/p1/threads/t1');
    await waitFor(() => expect(result.current.display).toBe('t1'));

    act(() => result.current.navigate('/projects/p1/threads/t2'));
    expect(result.current.display).toBe('t1');

    act(() => {
      useThreadStore.setState({
        threadDataById: {
          t1: { ...baseThread, id: 't1' },
          t2: { ...baseThread, id: 't2' },
        },
      } as any);
    });

    await waitFor(() => expect(result.current.display).toBe('t2'));
  });
});
