import { afterEach, beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import { mocked, stubGlobal, unstubAllGlobals } from '@funny/test-kit';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';

import { useSidebarScrollSync } from '@/hooks/use-sidebar-scroll-sync';
import { useProjectStore } from '@/stores/project-store';

// Spy on the scroll helper; keep the rest of utils real.
const actualUtils = { ...(await import('@/lib/utils')) };
mock.module('@/lib/utils', () => ({ ...actualUtils, scrollSidebarItemIntoView: vi.fn() }));
import { scrollSidebarItemIntoView } from '@/lib/utils';

function wrapperFor(route: string) {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
  );
}

/** Detached projects pane containing two thread rows under project p1. */
function makeScrollRoot() {
  const root = document.createElement('div');
  root.innerHTML =
    '<div data-project-id="p1">' +
    '<div data-testid="thread-item-t-a"></div>' +
    '<div data-testid="thread-item-t-b"></div>' +
    '</div>';
  return root;
}

describe('useSidebarScrollSync — scroll target follows the URL', () => {
  beforeEach(() => {
    // Run rAF synchronously so the first scroll attempt fires within the test.
    stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    stubGlobal('cancelAnimationFrame', () => {});
    useProjectStore.setState({
      expandedProjects: new Set(['p1']),
      revealNonce: 0,
      revealIntent: 'nearest',
      toggleProject: vi.fn(),
    });
  });

  afterEach(() => {
    unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('scrolls to the row matching the URL thread', () => {
    const root = makeScrollRoot();
    renderHook(
      () =>
        useSidebarScrollSync({
          selectedProjectId: 'p1',
          projectsScrollRef: { current: root },
          settingsNavOpen: false,
        }),
      { wrapper: wrapperFor('/projects/p1/threads/t-b') },
    );

    const calls = mocked(scrollSidebarItemIntoView).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const scrolledEl = calls[calls.length - 1][1];
    expect(scrolledEl.getAttribute('data-testid')).toBe('thread-item-t-b');
  });

  test('a different URL thread changes the scroll target', () => {
    const root = makeScrollRoot();
    renderHook(
      () =>
        useSidebarScrollSync({
          selectedProjectId: 'p1',
          projectsScrollRef: { current: root },
          settingsNavOpen: false,
        }),
      { wrapper: wrapperFor('/projects/p1/threads/t-a') },
    );

    const calls = mocked(scrollSidebarItemIntoView).mock.calls;
    const scrolledEl = calls[calls.length - 1][1];
    expect(scrolledEl.getAttribute('data-testid')).toBe('thread-item-t-a');
  });
});
