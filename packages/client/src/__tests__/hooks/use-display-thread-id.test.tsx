import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, test } from 'vitest';

import { buildThreadWithMessages } from '@/data/threads/testing';
import { useDisplayThreadId } from '@/hooks/use-display-thread-id';
import { useThreadStore } from '@/stores/thread-store';

const baseThread = buildThreadWithMessages({ title: 'One', status: 'idle' });

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
    useThreadStore.setState({ threadDataById: {}, activeThread: null });
  });

  test('returns null on a non-thread route', () => {
    const { result } = renderAt('/');
    expect(result.current.display).toBeNull();
  });

  test('keeps the previous display id while the new URL thread is still loading', async () => {
    useThreadStore.setState({ threadDataById: { t1: { ...baseThread, id: 't1' } } });
    const { result } = renderAt('/projects/p1/threads/t1');
    await waitFor(() => expect(result.current.display).toBe('t1'));

    // Navigate to t2, whose payload isn't loaded yet → display stays on t1.
    act(() => result.current.navigate('/projects/p1/threads/t2'));
    expect(result.current.display).toBe('t1');
  });

  test('advances to the URL thread once its payload is in threadDataById', async () => {
    useThreadStore.setState({ threadDataById: { t1: { ...baseThread, id: 't1' } } });
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
      });
    });

    await waitFor(() => expect(result.current.display).toBe('t2'));
  });
});
