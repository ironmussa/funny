import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { expect, test, vi } from 'vitest';

import { useAppShell } from '@/hooks/use-app-shell';
import { useAgentTemplateStore } from '@/stores/agent-template-store';
import { useProjectStore } from '@/stores/project-store';
import { getUrlThreadId, useThreadStore } from '@/stores/thread-store';

const ensureBranch = vi.fn().mockResolvedValue(false);

vi.mock('@/hooks/use-branch-switch', () => ({
  useBranchSwitch: () => ({ ensureBranch, branchSwitchDialog: null }),
}));
vi.mock('@/stores/thread-context', () => ({
  useThreadCore: () => useThreadStore((s) => s.activeThread),
}));
vi.mock('@/hooks/use-ws', () => ({ useWS: vi.fn() }));
vi.mock('@/hooks/use-refresh-on-focus', () => ({ useRefreshOnFocus: vi.fn() }));
vi.mock('@/hooks/use-document-title', () => ({ useDocumentTitle: vi.fn() }));
vi.mock('@/hooks/use-global-shortcuts', () => ({ useGlobalShortcuts: vi.fn() }));
vi.mock('@/hooks/use-thread-history-tracker', () => ({ useThreadHistoryTracker: vi.fn() }));

test('opening a thread URL loads its conversation without trying to switch branches', () => {
  const selectThread = vi.fn().mockImplementation(async (id: string) => {
    useThreadStore.setState({
      selectedThreadId: id,
      activeThread: {
        id,
        projectId: 'p1',
        mode: 'local',
        branch: 'deleted-branch',
      } as any,
    });
  });
  useProjectStore.setState({
    initialized: true,
    selectedProjectId: 'p1',
    projects: [{ id: 'p1', name: 'Deleted directory', path: '/missing/project' } as any],
    loadProjects: vi.fn(),
  });
  useAgentTemplateStore.setState({ loadTemplates: vi.fn() });
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
