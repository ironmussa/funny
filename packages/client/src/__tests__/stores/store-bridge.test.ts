import { describe, test, expect, vi } from 'bun:test';

import { createStore } from 'zustand/vanilla';

import { buildProject, seedProjects } from '@/data/projects/testing';
import { setSourceMembers } from '@/data/threads/list-meta';
import { getThreadsData } from '@/data/threads/store';

/**
 * We test store-bridge by dynamically importing it fresh for each test
 * so the lazy refs (projectStoreRef, threadStoreRef) start as null.
 */

/** A real vanilla store holding just the fields a test needs, as `StoreApi<T>`. */
function createMockStore<T extends object>(initialState: T) {
  return createStore<T>()(() => ({ ...initialState }));
}

// We need a fresh module for each test to reset the internal refs. bun has no
// vi.resetModules(): a query string loads a new instance of store-bridge, which
// still shares the already-loaded data layer (re-importing TanStack DB on every
// test can exceed the test timeout in a full run).
let freshCount = 0;
async function freshBridge(): Promise<typeof import('@/stores/store-bridge')> {
  freshCount += 1;
  return (await import(
    `@/stores/store-bridge?fresh=${freshCount}`
  )) as typeof import('@/stores/store-bridge');
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
      seedProjects([]);
      expect(bridge.getProjectPath('p1')).toBeUndefined();
    });
  });

  describe('after registration', () => {
    test('ensureThreadsLoaded calls loadThreadsForProject when not loaded', async () => {
      const bridge = await freshBridge();

      const loadThreadsForProject = vi.fn();
      const threadStore = createMockStore({
        threadIdsByProject: {},
        loadThreadsForProject,
      });

      bridge.registerThreadStore(threadStore);
      bridge.ensureThreadsLoaded('p1');

      expect(loadThreadsForProject).toHaveBeenCalledWith('p1');
    });

    test('ensureThreadsLoaded skips if threads already loaded', async () => {
      const bridge = await freshBridge();
      setSourceMembers(getThreadsData().meta, 'project:p1', ['t1'], 1);

      const loadThreadsForProject = vi.fn();
      const threadStore = createMockStore({ loadThreadsForProject });

      bridge.registerThreadStore(threadStore);
      bridge.ensureThreadsLoaded('p1');

      expect(loadThreadsForProject).not.toHaveBeenCalled();
    });

    test('clearProjectThreads delegates to thread store', async () => {
      const bridge = await freshBridge();

      const clearProjectThreads = vi.fn();
      const threadStore = createMockStore({
        clearProjectThreads,
      });

      bridge.registerThreadStore(threadStore);
      bridge.clearProjectThreads('p1');

      expect(clearProjectThreads).toHaveBeenCalledWith('p1');
    });

    test('expandProject adds to expandedProjects set', async () => {
      const bridge = await freshBridge();

      const projectStore = createMockStore({
        expandedProjects: new Set<string>(),
      });

      bridge.registerProjectStore(projectStore);
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
      bridge.registerProjectStore(projectStore);
      bridge.expandProject('p1');

      expect(setStateSpy).not.toHaveBeenCalled();
    });

    test('selectProject sets selectedProjectId on project store', async () => {
      const bridge = await freshBridge();

      const projectStore = createMockStore<{ selectedProjectId: string | null }>({
        selectedProjectId: null,
      });

      bridge.registerProjectStore(projectStore);
      bridge.selectProject('p1');

      expect(projectStore.getState().selectedProjectId).toBe('p1');
    });

    test('getProjectPath returns correct path', async () => {
      const bridge = await freshBridge();
      // Regression: project rows moved to the data layer; reading them off the
      // project store threw "Cannot read properties of undefined (reading 'find')".
      seedProjects([
        buildProject({ id: 'p1', name: 'p1', path: '/home/user/project-a' }),
        buildProject({ id: 'p2', name: 'p2', path: '/home/user/project-b' }),
      ]);
      bridge.registerProjectStore(createMockStore({ selectedProjectId: null }));

      expect(bridge.getProjectPath('p1')).toBe('/home/user/project-a');
      expect(bridge.getProjectPath('p2')).toBe('/home/user/project-b');
    });

    test('getProjectPath returns undefined for unknown project', async () => {
      const bridge = await freshBridge();
      seedProjects([buildProject({ id: 'p1', name: 'p1', path: '/home/user/project-a' })]);

      expect(bridge.getProjectPath('unknown')).toBeUndefined();
    });
  });
});
