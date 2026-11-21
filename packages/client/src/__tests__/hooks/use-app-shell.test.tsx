import { expect, test, vi, mock } from 'bun:test';

import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';

import { buildProject, withProjects } from '@/data/projects/testing';
import { buildThreadWithMessages } from '@/data/threads/testing';
import { useAppShell } from '@/hooks/use-app-shell';
import { useProjectStore } from '@/stores/project-store';
import { getUrlThreadId, useThreadStore } from '@/stores/thread-store';

const ensureBranch = vi.fn().mockResolvedValue(false);

mock.module('@/hooks/use-branch-switch', () => ({
  useBranchSwitch: () => ({ ensureBranch, branchSwitchDialog: null }),
}));
mock.module('@/stores/thread-context', () => ({
  useThreadCore: () => useThreadStore((s) => s.activeThread),
}));
mock.module('@/hooks/use-ws', () => ({ useWS: vi.fn() }));
mock.module('@/data/templates/loaders', () => ({ loadTemplates: vi.fn() }));
mock.module('@/hooks/use-refresh-on-focus', () => ({ useRefreshOnFocus: vi.fn() }));
mock.module('@/hooks/use-document-title', () => ({ useDocumentTitle: vi.fn() }));
mock.module('@/hooks/use-global-shortcuts', () => ({ useGlobalShortcuts: vi.fn() }));
mock.module('@/hooks/use-thread-history-tracker', () => ({ useThreadHistoryTracker: vi.fn() }));

test('opening a thread URL loads its conversation without trying to switch branches', () => {
  const selectThread = vi.fn().mockImplementation(async (id: string) => {
    useThreadStore.setState({
      selectedThreadId: id,
      activeThread: buildThreadWithMessages({ id, branch: 'deleted-branch' }),
    });
  });
  useProjectStore.setState(
    withProjects({
      initialized: true,
      selectedProjectId: 'p1',
      projects: [buildProject({ name: 'Deleted directory', path: '/missing/project' })],
      loadProjects: vi.fn(),
    }),
  );
  useThreadStore.setState({
    selectedThreadId: null,
    activeThread: null,
    selectThread,
    loadScratchThreads: vi.fn(),
    loadSharedThreads: vi.fn(),
  });

  const { rerender } = renderHook(() => useAppShell(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <MemoryRouter initialEntries={['/projects/p1/threads/t1']}>{children}</MemoryRouter>
    ),
  });

  rerender();

  expect(getUrlThreadId()).toBe('t1');
  expect(selectThread).toHaveBeenCalledWith('t1');
  expect(ensureBranch).not.toHaveBeenCalled();
});
