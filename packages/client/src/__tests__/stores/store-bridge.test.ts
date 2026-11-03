import { describe, test, expect, vi } from 'vitest';

/**
 * We test store-bridge by dynamically importing it fresh for each test
 * so the lazy refs (_projectStoreRef, _threadStoreRef) start as null.
 */

function createMockStore<T extends Record<string, any>>(initialState: T) {
  let state = { ...initialState };
  return {
    getState: () => state,
    setState: (partial: Partial<T>) => {
      state = { ...state, ...partial };
    },
    subscribe: vi.fn(),
    destroy: vi.fn(),
  };
}

// We need a fresh module for each test to reset the internal refs.
async function freshBridge() {
  // Clear the cached module so we get fresh lazy refs
  const modulePath = '@/stores/store-bridge';
  vi.resetModules();
  return import(modulePath);
}

describe('store-bridge', () => {
  describe('before registration', () => {
    test('ensureThreadsLoaded is a no-op and does not throw', async () => {
      const bridge = await freshBridge();
      expect(() => bridge.ensureThreadsLoaded('p1')).not.toThrow();
    });

    test('clearProjectThreads is a no-op and does not throw', async () => {
      const bridge = await freshBridge();
      expect(() => bridge.clearProjectThreads('p1')).not.toThrow();
    });

    test('expandProject is a no-op and does not throw', async () => {
      const bridge = await freshBridge();
      expect(() => bridge.expandProject('p1')).not.toThrow();
    });

    test('selectProject is a no-op and does not throw', async () => {
      const bridge = await freshBridge();
      expect(() => bridge.selectProject('p1')).not.toThrow();
    });

    test('getProjectPath returns undefined', async () => {
      const bridge = await freshBridge();
      expect(bridge.getProjectPath('p1')).toBeUndefined();
    });
  });

  describe('after registration', () => {
    test('ensureThreadsLoaded calls loadThreadsForProject when not loaded', async () => {
      const bridge = await freshBridge();

      const loadThreadsForProject = vi.fn();
      const threadStore = createMockStore({
        threadIdsByProject: {} as Record<string, string[]>,
        loadThreadsForProject,
      });

      bridge.registerThreadStore(threadStore as any);
      bridge.ensureThreadsLoaded('p1');

      expect(loadThreadsForProject).toHaveBeenCalledWith('p1');
    });

    test('ensureThreadsLoaded skips if threads already loaded', async () => {
      const bridge = await freshBridge();
      const { getThreadsData } = await import('@/data/threads/store');
      const { setSourceMembers } = await import('@/data/threads/list-meta');
      setSourceMembers(getThreadsData().meta, 'project:p1', ['t1'], 1);

      const loadThreadsForProject = vi.fn();
      const threadStore = createMockStore({ loadThreadsForProject });

      bridge.registerThreadStore(threadStore as any);
      bridge.ensureThreadsLoaded('p1');

      expect(loadThreadsForProject).not.toHaveBeenCalled();
    });

    test('getThreadsByProject derives from the thread rows and project lists', async () => {
      const bridge = await freshBridge();
      const { getThreadsData } = await import('@/data/threads/store');
      const { setSourceMembers } = await import('@/data/threads/list-meta');

      const t1 = { id: 't1', projectId: 'p1', title: 'one' } as any;
      const t2 = { id: 't2', projectId: 'p2', title: 'two' } as any;
      const data = getThreadsData();
      data.upsertFromServer([t1, t2], data.beginRequest());
      setSourceMembers(data.meta, 'project:p1', ['t1', 't1'], 1);
      setSourceMembers(data.meta, 'project:p2', ['t2'], 1);
      setSourceMembers(data.meta, 'project:', ['t1'], 1);

      bridge.registerThreadStore(createMockStore({}) as any);

      // Regression: before unified-store, `getThreadsByProject` returned
      // `state.threadsByProject` directly — once that field was removed it
      // returned `undefined` and crashed every consumer (git-status-store,
      // ThreadList, ProjectItem, etc.). It must derive, de-duplicate IDs and
      // skip the empty project id.
      const result = bridge.getThreadsByProject();
      expect(result).toEqual({ p1: [t1], p2: [t2] });
    });

    test('getThreadsByProject is empty before any project list loads', async () => {
      const bridge = await freshBridge();

      // Defensive: tests / stories may seed a partial store. Returning
      // `{}` keeps the contract intact instead of throwing on the
      // `for (const pid in undefined)` walk.
      const threadStore = createMockStore({ threadsById: {} });
      bridge.registerThreadStore(threadStore as any);

      expect(bridge.getThreadsByProject()).toEqual({});
    });

    test('clearProjectThreads delegates to thread store', async () => {
      const bridge = await freshBridge();

      const clearProjectThreads = vi.fn();
      const threadStore = createMockStore({
        clearProjectThreads,
      });

      bridge.registerThreadStore(threadStore as any);
      bridge.clearProjectThreads('p1');

      expect(clearProjectThreads).toHaveBeenCalledWith('p1');
    });

    test('expandProject adds to expandedProjects set', async () => {
      const bridge = await freshBridge();

      const projectStore = createMockStore({
        expandedProjects: new Set<string>(),
      });

      bridge.registerProjectStore(projectStore as any);
      bridge.expandProject('p1');

      const state = projectStore.getState();
      expect(state.expandedProjects.has('p1')).toBe(true);
    });

    test('expandProject does not update if project already expanded', async () => {
      const bridge = await freshBridge();

      const projectStore = createMockStore({
        expandedProjects: new Set<string>(['p1']),
      });

      const setStateSpy = vi.spyOn(projectStore, 'setState');
      bridge.registerProjectStore(projectStore as any);
      bridge.expandProject('p1');

      expect(setStateSpy).not.toHaveBeenCalled();
    });

    test('selectProject sets selectedProjectId on project store', async () => {
      const bridge = await freshBridge();

      const projectStore = createMockStore({
        selectedProjectId: null as string | null,
      });

      bridge.registerProjectStore(projectStore as any);
      bridge.selectProject('p1');

      expect(projectStore.getState().selectedProjectId).toBe('p1');
    });

    test('getProjectPath returns correct path', async () => {
      const bridge = await freshBridge();

      const projectStore = createMockStore({
        projects: [
          { id: 'p1', path: '/home/user/project-a' },
          { id: 'p2', path: '/home/user/project-b' },
        ],
      });

      bridge.registerProjectStore(projectStore as any);

      expect(bridge.getProjectPath('p1')).toBe('/home/user/project-a');
      expect(bridge.getProjectPath('p2')).toBe('/home/user/project-b');
    });

    test('getProjectPath returns undefined for unknown project', async () => {
      const bridge = await freshBridge();

      const projectStore = createMockStore({
        projects: [{ id: 'p1', path: '/home/user/project-a' }],
      });

      bridge.registerProjectStore(projectStore as any);

      expect(bridge.getProjectPath('unknown')).toBeUndefined();
    });
  });
});
