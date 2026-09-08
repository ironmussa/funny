import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';

import { useMobileNavigation } from '@/hooks/use-mobile-navigation';
import { getNavigate, getUrlThreadId } from '@/stores/thread-store-internals';

vi.mock('@/hooks/use-org-auto-switch', () => ({ useOrgAutoSwitch: () => {} }));

function setup(route = '/') {
  return renderHook(
    () => ({
      ...useMobileNavigation(true),
      location: useLocation(),
      navigate: useNavigate(),
    }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
      ),
    },
  );
}

describe('mobile URL navigation', () => {
  test.each([
    ['/acme/projects/p1/threads/t1', 'chat'],
    ['/projects/p1', 'threads'],
    ['/projects/p1?view=search&q=hello&case=1', 'search'],
    ['/projects/p1?view=newThread', 'newThread'],
    ['/projects/p1?view=settings', 'settings'],
    ['/projects/p1/settings/general', 'settings'],
    ['/scratch/t1', 'chat'],
    ['/', 'projects'],
  ])('restores %s on a fresh mount', (route, screen) => {
    const { result } = setup(route);
    expect(result.current.view.screen).toBe(screen);
    expect(result.current.location.pathname + result.current.location.search).toBe(route);
  });

  test('updates the URL, preserves the org, and follows back and forward', async () => {
    const { result } = setup('/acme/');
    act(() => result.current.setView({ screen: 'threads', projectId: 'p1' }));
    expect(result.current.location.pathname).toBe('/acme/projects/p1');
    act(() =>
      result.current.setView({ screen: 'chat', projectId: 'p1', threadId: 't1', from: 'threads' }),
    );
    expect(result.current.location.pathname).toBe('/acme/projects/p1/threads/t1');
    expect(getUrlThreadId()).toBe('t1');
    await act(() => result.current.navigate(-1));
    expect(result.current.view.screen).toBe('threads');
    expect(getUrlThreadId()).toBeNull();
    await act(() => result.current.navigate(1));
    expect(result.current.view.screen).toBe('chat');
  });

  test('preserves search and case through a result, reload and return', () => {
    const { result, unmount } = setup('/projects/p1?view=search');
    act(() => result.current.setSearchQuery('hello world'));
    act(() => result.current.setSearchCaseSensitive(true));
    act(() =>
      result.current.setView({ screen: 'chat', projectId: 'p1', threadId: 't1', from: 'search' }),
    );
    const route = result.current.location.pathname + result.current.location.search;
    unmount();
    const restored = setup(route);
    expect(restored.result.current.view).toMatchObject({ screen: 'chat', from: 'search' });
    act(() => restored.result.current.setView({ screen: 'search', projectId: 'p1' }));
    expect(restored.result.current.searchQuery).toBe('hello world');
    expect(restored.result.current.searchCaseSensitive).toBe(true);
  });

  test('store navigation updates both URL and screen', () => {
    const { result } = setup();
    act(() => getNavigate()?.('/projects/p1/threads/t2'));
    expect(result.current.location.pathname).toBe('/projects/p1/threads/t2');
    expect(result.current.view).toMatchObject({ screen: 'chat', threadId: 't2' });
  });

  test('created thread replaces the composer history entry', async () => {
    const { result } = setup('/projects/p1');
    act(() => result.current.setView({ screen: 'newThread', projectId: 'p1' }));
    act(() =>
      result.current.setView(
        { screen: 'chat', projectId: 'p1', threadId: 't1', from: 'threads' },
        true,
      ),
    );
    await act(() => result.current.navigate(-1));
    expect(result.current.view.screen).toBe('threads');
  });
});
