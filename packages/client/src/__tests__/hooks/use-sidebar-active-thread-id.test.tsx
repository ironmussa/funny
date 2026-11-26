import { afterEach, describe, expect, test } from 'bun:test';

import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';

import { useSidebarActiveThreadId } from '@/hooks/use-sidebar-active-thread-id';
import { useUIStore } from '@/stores/ui-store';

function wrapperFor(route: string) {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
  );
}

describe('useSidebarActiveThreadId', () => {
  afterEach(() => {
    act(() => {
      useUIStore.setState({ liveColumnsOpen: false, gridSelectedThreadId: null });
    });
  });

  test('returns the URL thread id outside the grid (no leak from stale grid selection)', () => {
    useUIStore.setState({ liveColumnsOpen: false, gridSelectedThreadId: 'grid-t' });
    const { result } = renderHook(() => useSidebarActiveThreadId(), {
      wrapper: wrapperFor('/projects/p1/threads/url-t'),
    });
    expect(result.current).toBe('url-t');
  });

  test('returns gridSelectedThreadId while the grid is open', () => {
    useUIStore.setState({ liveColumnsOpen: true, gridSelectedThreadId: 'grid-t' });
    const { result } = renderHook(() => useSidebarActiveThreadId(), {
      wrapper: wrapperFor('/grid'),
    });
    expect(result.current).toBe('grid-t');
  });

  test('updates reactively when gridSelectedThreadId changes', () => {
    useUIStore.setState({ liveColumnsOpen: true, gridSelectedThreadId: 'grid-1' });
    const { result } = renderHook(() => useSidebarActiveThreadId(), {
      wrapper: wrapperFor('/grid'),
    });
    expect(result.current).toBe('grid-1');

    act(() => {
      useUIStore.getState().setGridSelectedThreadId('grid-2');
    });
    expect(result.current).toBe('grid-2');

    act(() => {
      useUIStore.getState().setGridSelectedThreadId(null);
    });
    expect(result.current).toBeNull();
  });
});
