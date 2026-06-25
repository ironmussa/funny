import type { Project } from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import { okAsync, errAsync } from 'neverthrow';
import { describe, test, expect, vi, beforeEach } from 'vitest';

// ── Shared mock state that we can reassign per test ──────────────────
const {
  mockLoadThreadsForProject,
  mockClearProjectThreads,
  mockThreadsByProject,
  mockFetchForProject,
  mockProjectsApi,
  mockThreadsApi,
  mockBatchUpdateThreads,
} = vi.hoisted(() => ({
  mockLoadThreadsForProject: vi.fn().mockResolvedValue(undefined),
  mockClearProjectThreads: vi.fn(),
  mockThreadsByProject: { current: {} as Record<string, unknown[]> },
  mockFetchForProject: vi.fn(),
  mockProjectsApi: {
    listProjects: vi.fn(),
    listBranches: vi
      .fn()
      .mockReturnValue(Promise.resolve({ isOk: () => false, isErr: () => true })),
    renameProject: vi.fn(),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
    reorderProjects: vi.fn(),
    setProjectLocalPath: vi.fn(),
  },
  mockThreadsApi: {
    listThreads: vi.fn(),
  },
  mockBatchUpdateThreads: vi.fn(),
}));

// Mock the API barrel (for any leftover consumers) and the specific sub-modules
// the store now imports directly.
vi.mock('@/lib/api', () => ({
  api: { ...mockProjectsApi, ...mockThreadsApi },
}));
vi.mock('@/lib/api/projects', () => ({ projectsApi: mockProjectsApi }));
vi.mock('@/lib/api/threads', () => ({ threadsApi: mockThreadsApi }));

vi.mock('@/stores/store-bridge', () => ({
  batchUpdateThreads: (...args: any[]) => mockBatchUpdateThreads(...args),
  ensureThreadsLoaded: (projectId: string) => {
    // Mimic the bridge logic: only call loadThreadsForProject if not already loaded
    if (!mockThreadsByProject.current[projectId]) {
      mockLoadThreadsForProject(projectId);
    }
  },
  clearProjectThreads: (...args: any[]) => mockClearProjectThreads(...args),
  fetchGitStatusForProject: vi.fn(),
  registerProjectStore: vi.fn(),
}));

vi.mock('@/stores/git-status-store', () => ({
  useGitStatusStore: {
    getState: () => ({
      fetchForProject: mockFetchForProject,
    }),
  },
}));

import { useProjectStore } from '@/stores/project-store';

const mockApi = mockProjectsApi;

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Project 1',
    path: '/tmp/p1',
    userId: 'u1',
    sortOrder: 0,
    createdAt: '2024-01-01',
    ...overrides,
  };
}

describe('ProjectStore', () => {
  beforeEach(() => {
    useProjectStore.setState({
      projects: [],
      expandedProjects: new Set(),
      selectedProjectId: null,
      initialized: false,
    });
    vi.clearAllMocks();
    mockThreadsByProject.current = {};
    mockThreadsApi.listThreads.mockReturnValue(
      okAsync({ threads: [], total: 0, hasMore: false }) as any,
    );
  });

  describe('Initial state', () => {
    test('has empty projects', () => {
      expect(useProjectStore.getState().projects).toEqual([]);
    });

    test('has no selectedProjectId', () => {
      expect(useProjectStore.getState().selectedProjectId).toBeNull();
    });

    test('has initialized=false', () => {
      expect(useProjectStore.getState().initialized).toBe(false);
    });
  });

  describe('loadProjects', () => {
    test('fetches and sets projects, sets initialized=true', async () => {
      const projects = [
        makeProject({ id: 'p1', name: 'Project 1' }),
        makeProject({ id: 'p2', name: 'Project 2', sortOrder: 1 }),
      ];
      mockApi.listProjects.mockReturnValueOnce(okAsync(projects) as any);

      await useProjectStore.getState().loadProjects();

      const state = useProjectStore.getState();
      expect(state.projects).toEqual(projects);
      expect(state.initialized).toBe(true);
    });

    test('triggers thread loading in background for all projects', async () => {
      const mockListThreads = mockThreadsApi.listThreads;

      const projects = [makeProject({ id: 'p1' }), makeProject({ id: 'p2' })];
      mockApi.listProjects.mockReturnValueOnce(okAsync(projects) as any);
      // loadProjects now calls threadsApi.listThreads directly for each project (batched)
      mockListThreads.mockReturnValue(okAsync({ threads: [], total: 0, hasMore: false }) as any);

      await useProjectStore.getState().loadProjects();

      // The batched thread loading happens in a fire-and-forget Promise.all,
      // so we wait a tick for it to complete
      await new Promise((r) => setTimeout(r, 50));

      expect(mockListThreads).toHaveBeenCalledWith('p1', false, 50);
      expect(mockListThreads).toHaveBeenCalledWith('p2', false, 50);
    });

    test('publishes each project threads as soon as that request resolves', async () => {
      const projects = [makeProject({ id: 'p1' }), makeProject({ id: 'p2' })];
      mockApi.listProjects.mockReturnValueOnce(okAsync(projects) as any);

      let resolveP1: (value: any) => void = () => {};
      let resolveP2: (value: any) => void = () => {};
      mockThreadsApi.listThreads.mockImplementation((projectId: string) => {
        if (projectId === 'p1') {
          return new Promise((resolve) => {
            resolveP1 = resolve;
          });
        }
        return new Promise((resolve) => {
          resolveP2 = resolve;
        });
      });

      await useProjectStore.getState().loadProjects();

      resolveP1(okAsync({ threads: [{ id: 't1' }], total: 1, hasMore: false }) as any);
      await new Promise((r) => setTimeout(r, 0));

      expect(mockBatchUpdateThreads).toHaveBeenCalledWith([
        { projectId: 'p1', threads: [{ id: 't1' }], total: 1 },
      ]);
      expect(mockBatchUpdateThreads).toHaveBeenCalledTimes(1);

      resolveP2(okAsync({ threads: [{ id: 't2' }], total: 1, hasMore: false }) as any);
      await new Promise((r) => setTimeout(r, 0));

      expect(mockBatchUpdateThreads).toHaveBeenCalledWith([
        { projectId: 'p2', threads: [{ id: 't2' }], total: 1 },
      ]);
    });

    test('loads the on-screen (active) project first so it wins the socket pool', async () => {
      // Active project from the URL is p2, which is NOT first in the array.
      window.history.pushState({}, '', '/projects/p2/threads/t1');
      const projects = [
        makeProject({ id: 'p1' }),
        makeProject({ id: 'p2' }),
        makeProject({ id: 'p3' }),
      ];
      mockApi.listProjects.mockReturnValueOnce(okAsync(projects) as any);
      mockThreadsApi.listThreads.mockReturnValue(
        okAsync({ threads: [], total: 0, hasMore: false }) as any,
      );

      await useProjectStore.getState().loadProjects();

      // The first listThreads dispatch must be the active project, ahead of the
      // others, so the visible thread's project claims a socket first.
      expect(mockThreadsApi.listThreads.mock.calls[0][0]).toBe('p2');

      window.history.pushState({}, '', '/');
    });

    test('handles API errors gracefully', async () => {
      const error: DomainError = { type: 'INTERNAL', message: 'Server error' };
      mockApi.listProjects.mockReturnValueOnce(errAsync(error) as any);

      await useProjectStore.getState().loadProjects();

      const state = useProjectStore.getState();
      expect(state.projects).toEqual([]);
      expect(state.initialized).toBe(false);
    });
  });

  describe('toggleProject', () => {
    test('adds projectId to expandedProjects', () => {
      useProjectStore.getState().toggleProject('p1');

      expect(useProjectStore.getState().expandedProjects.has('p1')).toBe(true);
    });

    test('removes projectId if already expanded', () => {
      useProjectStore.setState({ expandedProjects: new Set(['p1']) });

      useProjectStore.getState().toggleProject('p1');

      expect(useProjectStore.getState().expandedProjects.has('p1')).toBe(false);
    });

    test('loads threads for newly expanded project', () => {
      useProjectStore.getState().toggleProject('p1');

      expect(mockLoadThreadsForProject).toHaveBeenCalledWith('p1');
    });

    test('does not load threads if already loaded', () => {
      mockThreadsByProject.current = { p1: [] };

      useProjectStore.getState().toggleProject('p1');

      expect(mockLoadThreadsForProject).not.toHaveBeenCalled();
    });
  });

  describe('selectProject', () => {
    test('sets selectedProjectId without auto-expanding', () => {
      useProjectStore.getState().selectProject('p1');

      const state = useProjectStore.getState();
      expect(state.selectedProjectId).toBe('p1');
      // selectProject no longer auto-expands the project
      expect(state.expandedProjects.has('p1')).toBe(false);
    });

    test('does not duplicate in expandedProjects if already expanded', () => {
      useProjectStore.setState({ expandedProjects: new Set(['p1']) });

      useProjectStore.getState().selectProject('p1');

      const state = useProjectStore.getState();
      expect(state.selectedProjectId).toBe('p1');
      expect(state.expandedProjects.has('p1')).toBe(true);
      expect(state.expandedProjects.size).toBe(1);
    });

    test('clears selectedProjectId with null', () => {
      useProjectStore.setState({ selectedProjectId: 'p1' });

      useProjectStore.getState().selectProject(null);

      expect(useProjectStore.getState().selectedProjectId).toBeNull();
    });

    test('loads threads for selected project', () => {
      useProjectStore.getState().selectProject('p1');

      expect(mockLoadThreadsForProject).toHaveBeenCalledWith('p1');
    });
  });

  describe('fetchBranch race with setBranch', () => {
    test('discards stale fetchBranch result when a checkout lands mid-flight', async () => {
      const pid = 'race-p1';
      let resolveList!: (v: unknown) => void;
      mockApi.listBranches.mockReturnValueOnce(
        new Promise((r) => {
          resolveList = r;
        }) as any,
      );

      // selectProject-style fetch begins; the branch listing is still in flight.
      const fetchPromise = useProjectStore.getState().fetchBranch(pid);

      // A checkout completes (ensureBranch → setBranch) before the listing returns.
      useProjectStore.getState().setBranch(pid, 'feat/x');
      expect(useProjectStore.getState().branchByProject[pid]).toBe('feat/x');

      // The in-flight listing resolves with the pre-checkout (stale) branch.
      resolveList({ isErr: () => false, value: { currentBranch: 'master' } });
      await fetchPromise;

      // Stale value must NOT clobber the authoritative checkout result.
      expect(useProjectStore.getState().branchByProject[pid]).toBe('feat/x');
    });

    test('applies fetchBranch result when no checkout intervenes', async () => {
      const pid = 'race-p2';
      mockApi.listBranches.mockReturnValueOnce(
        Promise.resolve({ isErr: () => false, value: { currentBranch: 'main' } }) as any,
      );

      await useProjectStore.getState().fetchBranch(pid);

      expect(useProjectStore.getState().branchByProject[pid]).toBe('main');
    });
  });

  describe('renameProject', () => {
    test('updates the project in the list', async () => {
      const original = makeProject({ id: 'p1', name: 'Old Name' });
      const renamed = makeProject({ id: 'p1', name: 'New Name' });
      useProjectStore.setState({ projects: [original] });
      mockApi.renameProject.mockReturnValueOnce(okAsync(renamed) as any);

      await useProjectStore.getState().renameProject('p1', 'New Name');

      const state = useProjectStore.getState();
      expect(state.projects).toHaveLength(1);
      expect(state.projects[0].name).toBe('New Name');
    });

    test('handles API errors (no update)', async () => {
      const original = makeProject({ id: 'p1', name: 'Old Name' });
      useProjectStore.setState({ projects: [original] });
      const error: DomainError = { type: 'NOT_FOUND', message: 'Not found' };
      mockApi.renameProject.mockReturnValueOnce(errAsync(error) as any);

      await useProjectStore.getState().renameProject('p1', 'New Name');

      const state = useProjectStore.getState();
      expect(state.projects[0].name).toBe('Old Name');
    });
  });

  describe('updateProject', () => {
    test('updates the project in the list', async () => {
      const original = makeProject({ id: 'p1', name: 'Project', color: undefined });
      const updated = makeProject({ id: 'p1', name: 'Project', color: '#ff0000' });
      useProjectStore.setState({ projects: [original] });
      mockApi.updateProject.mockReturnValueOnce(okAsync(updated) as any);

      await useProjectStore.getState().updateProject('p1', { color: '#ff0000' });

      const state = useProjectStore.getState();
      expect(state.projects[0].color).toBe('#ff0000');
    });
  });

  describe('deleteProject', () => {
    test('removes project from list', async () => {
      const p1 = makeProject({ id: 'p1' });
      const p2 = makeProject({ id: 'p2', name: 'Project 2' });
      useProjectStore.setState({
        projects: [p1, p2],
        expandedProjects: new Set(['p1']),
      });
      mockApi.deleteProject.mockReturnValueOnce(okAsync(undefined) as any);

      await useProjectStore.getState().deleteProject('p1');

      const state = useProjectStore.getState();
      expect(state.projects).toHaveLength(1);
      expect(state.projects[0].id).toBe('p2');
      expect(state.expandedProjects.has('p1')).toBe(false);
    });

    test('clears selectedProjectId if deleted project was selected', async () => {
      const p1 = makeProject({ id: 'p1' });
      useProjectStore.setState({
        projects: [p1],
        selectedProjectId: 'p1',
        expandedProjects: new Set(['p1']),
      });
      mockApi.deleteProject.mockReturnValueOnce(okAsync(undefined) as any);

      await useProjectStore.getState().deleteProject('p1');

      expect(useProjectStore.getState().selectedProjectId).toBeNull();
    });

    test('does not clear selectedProjectId if different project was selected', async () => {
      const p1 = makeProject({ id: 'p1' });
      const p2 = makeProject({ id: 'p2', name: 'Project 2' });
      useProjectStore.setState({
        projects: [p1, p2],
        selectedProjectId: 'p2',
        expandedProjects: new Set(['p1']),
      });
      mockApi.deleteProject.mockReturnValueOnce(okAsync(undefined) as any);

      await useProjectStore.getState().deleteProject('p1');

      expect(useProjectStore.getState().selectedProjectId).toBe('p2');
    });

    test('clears project threads via thread store', async () => {
      const p1 = makeProject({ id: 'p1' });
      useProjectStore.setState({ projects: [p1] });
      mockApi.deleteProject.mockReturnValueOnce(okAsync(undefined) as any);

      await useProjectStore.getState().deleteProject('p1');

      expect(mockClearProjectThreads).toHaveBeenCalledWith('p1');
    });

    test('does not remove project on API error', async () => {
      const p1 = makeProject({ id: 'p1' });
      useProjectStore.setState({ projects: [p1] });
      const error: DomainError = { type: 'INTERNAL', message: 'Server error' };
      mockApi.deleteProject.mockReturnValueOnce(errAsync(error) as any);

      await useProjectStore.getState().deleteProject('p1');

      expect(useProjectStore.getState().projects).toHaveLength(1);
    });
  });

  describe('reorderProjects', () => {
    test('optimistically reorders projects', async () => {
      const p1 = makeProject({ id: 'p1', name: 'First', sortOrder: 0 });
      const p2 = makeProject({ id: 'p2', name: 'Second', sortOrder: 1 });
      const p3 = makeProject({ id: 'p3', name: 'Third', sortOrder: 2 });
      useProjectStore.setState({ projects: [p1, p2, p3] });
      mockApi.reorderProjects.mockReturnValueOnce(okAsync(undefined) as any);

      await useProjectStore.getState().reorderProjects(['p3', 'p1', 'p2']);

      const state = useProjectStore.getState();
      expect(state.projects.map((p) => p.id)).toEqual(['p3', 'p1', 'p2']);
    });

    test('reverts on API failure', async () => {
      const p1 = makeProject({ id: 'p1', name: 'First', sortOrder: 0 });
      const p2 = makeProject({ id: 'p2', name: 'Second', sortOrder: 1 });
      const p3 = makeProject({ id: 'p3', name: 'Third', sortOrder: 2 });
      useProjectStore.setState({ projects: [p1, p2, p3] });
      const error: DomainError = { type: 'INTERNAL', message: 'Server error' };
      mockApi.reorderProjects.mockReturnValueOnce(errAsync(error) as any);

      await useProjectStore.getState().reorderProjects(['p3', 'p1', 'p2']);

      // Should revert to original order
      const state = useProjectStore.getState();
      expect(state.projects.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    });
  });
});
