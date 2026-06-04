import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { useRouteSync } from '@/hooks/use-route-sync';
import { useProjectStore } from '@/stores/project-store';
import { getUrlThreadId, useThreadStore } from '@/stores/thread-store';

function wrapperFor(route: string) {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
  );
}

// The invariant guard (and `resolveInvariantThreadId`) were removed with the
// route-driven migration — WS routing/refresh and the display read the URL
// directly via getUrlThreadId(), so there is nothing to reconcile. What remains
// to test here is that useRouteSync mirrors the URL thread id into the store.
describe('useRouteSync — URL thread id mirror', () => {
  beforeEach(() => {
    useProjectStore.setState({ initialized: true } as any);
    useThreadStore.setState({ selectThread: vi.fn().mockResolvedValue(undefined) } as any);
  });
  afterEach(() => vi.restoreAllMocks());

  test('mirrors a project thread route into the store layer', () => {
    renderHook(() => useRouteSync(), { wrapper: wrapperFor('/projects/p1/threads/T123') });
    expect(getUrlThreadId()).toBe('T123');
  });

  test('mirrors a scratch thread route', () => {
    renderHook(() => useRouteSync(), { wrapper: wrapperFor('/scratch/S9') });
    expect(getUrlThreadId()).toBe('S9');
  });

  test('is null on a non-thread route', () => {
    renderHook(() => useRouteSync(), { wrapper: wrapperFor('/projects/p1') });
    expect(getUrlThreadId()).toBeNull();
  });
});
